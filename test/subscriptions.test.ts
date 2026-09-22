import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { render as prompt } from '@inquirer/testing';
import { targetPicker } from '../src/picker.js';
import { continuePicker } from './picker-helpers.js';
import {
  catalogManifestSchema,
  catalogUrlSchema,
  parse,
  type CatalogManifest,
  type ExternalKit,
} from '../src/schema.js';
import {
  cachePath,
  officialCatalogUrl,
  readCatalogCache,
  refreshCatalogs,
  subscriptions,
  writeCache,
} from '../src/subscriptions.js';
import { editSubscription } from '../src/catalog-config.js';
import { loadCatalog } from '../src/catalog.js';
import { loadTarget } from '../src/targets.js';
import { apply, loadState, plan } from '../src/storage.js';
import { configure } from '../src/resolve.js';
import {
  blobHash,
  catalogForUpdates,
  renderWithExternal,
  readExternal,
  hashSource,
  type FetchBytes,
} from '../src/external.js';
import { availableUpdates } from '../src/updates.js';
import { selectionSummary } from '../src/review.js';
import { interactive } from '../src/setup.js';
import { type PromptContext } from '../src/interactive.js';

const url = 'https://example.com/catalog.yaml';
const revision = '1'.repeat(40);
const skill: ExternalKit = {
  id: 'sample-helper',
  description: 'Sample helper',
  source: {
    repo: 'example/kits',
    ref: revision,
    skills: ['skills/sample-helper'],
    license: 'LICENSE',
  },
};
function manifest(
  kits: ExternalKit[] = [skill],
  id = 'sample',
): CatalogManifest {
  return parse(
    catalogManifestSchema,
    {
      schemaVersion: 1,
      id,
      name: 'Sample catalog',
      providers: [
        {
          id: 'sample',
          description: 'Sample provider',
          prefix: 'sample-',
          kits,
        },
      ],
    },
    'fixture',
  );
}
function put(root: string, file: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}
function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-subscriptions-'));
  const previous = process.env.LOADOUT_CACHE_DIR;
  process.env.LOADOUT_CACHE_DIR = path.join(home, 'cache');
  t.mock.method(os, 'homedir', () => home);
  t.after(() => {
    if (previous === undefined) delete process.env.LOADOUT_CACHE_DIR;
    else process.env.LOADOUT_CACHE_DIR = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  put(home, '.loadout/config.yaml', 'schemaVersion: 1\ncurated: false\n');
  const repo = path.join(home, 'repo');
  const second = path.join(home, 'second');
  fs.mkdirSync(repo);
  fs.mkdirSync(second);
  return { home, repo, second };
}
function cache(value = manifest(), address = url, fetchedAt = Date.now()) {
  writeCache(cachePath('catalogs', address), {
    url: address,
    fetchedAt,
    manifest: value,
  });
}
const upstream =
  (text = 'Original guidance', license?: string): FetchBytes =>
  async (address) => {
    const files = new Map<string, Buffer>([
      ['LICENSE', Buffer.from('MIT License')],
      [
        'skills/sample-helper/SKILL.md',
        Buffer.from('---\nname: sample-helper\ndescription: Help\n---\nHelper'),
      ],
      ['kits/workflow/instructions.md', Buffer.from(text)],
      [
        'kits/workflow/skills/sample-workflow/SKILL.md',
        Buffer.from(
          '---\nname: sample-workflow\ndescription: Workflow\n---\nWorkflow',
        ),
      ],
      [
        'kits/workflow/skills/sample-workflow/references/check.md',
        Buffer.from('Supporting reference'),
      ],
    ]);
    if (license)
      files.set(
        'kits/workflow/skills/sample-workflow/LICENSE.upstream',
        Buffer.from(license),
      );
    if (address.startsWith('https://api.github.com/'))
      return Buffer.from(
        JSON.stringify({
          truncated: false,
          tree: [...files].map(([file, content]) => ({
            path: file,
            type: 'blob',
            mode: '100644',
            size: content.length,
            sha: blobHash(content),
          })),
        }),
      );
    const file = decodeURIComponent(
      new URL(address).pathname.split('/').slice(4).join('/'),
    );
    assert.ok(files.has(file), address);
    return files.get(file)!;
  };
const offline: FetchBytes = async () => {
  throw new Error('Unexpected network request');
};
function workflow(ref = revision): ExternalKit {
  return {
    id: 'sample-workflow',
    description: 'Conditional workflow',
    source: {
      repo: 'example/kits',
      ref,
      skills: [],
      license: 'LICENSE',
      kit: {
        path: 'kits/workflow',
        manifest: {
          schemaVersion: 1,
          id: 'sample-workflow',
          description: 'Conditional workflow',
          requires: ['sample-helper'],
          questions: {
            placement: {
              type: 'choice',
              message: 'Where?',
              choices: ['context', 'skill'],
            },
          },
          outputs: [
            {
              type: 'instructions',
              source: 'instructions.md',
              scope: '.',
              when: { answer: 'placement', equals: 'context' },
            },
            {
              type: 'skill',
              source: 'skills/sample-workflow',
              when: { answer: 'placement', equals: 'skill' },
            },
          ],
        },
      },
    },
  };
}

test('subscriptions combine personal, repository, and private scopes without duplicating kits or selections', (t) => {
  const { home, repo, second } = fixture(t);
  editSubscription(home, '.loadout', 'add', url);
  editSubscription(repo, '.loadout', 'add', url);
  editSubscription(repo, '.loadout-personal', 'add', url);
  cache();
  assert.deepEqual(subscriptions(repo), [
    { url, scopes: ['Personal', 'Repository', 'Repository private'] },
  ]);
  assert.deepEqual(subscriptions(home, true), [{ url, scopes: ['Personal'] }]);
  assert.equal(loadCatalog(repo).kits.size, 1);
  assert.ok(loadCatalog(second).kits.has(skill.id));
  put(
    repo,
    '.loadout-personal/local.json',
    JSON.stringify({ schemaVersion: 1, selected: [skill.id], answers: {} }),
  );
  assert.deepEqual(loadState(loadCatalog(second)).selected, []);
  assert.deepEqual(loadState(loadCatalog(home, true)).selected, []);
  assert.deepEqual(loadCatalog(repo).kits.get(skill.id)?.subscriptions, [
    'Personal',
    'Repository',
    'Repository private',
  ]);
  editSubscription(home, '.loadout', 'remove', url);
  assert.equal(loadCatalog(second).kits.size, 0);
  assert.equal(loadCatalog(repo).kits.size, 1);
});

test('cache refresh deduplicates downloads, respects offline mode, and keeps the last valid manifest', async (t) => {
  const { home, repo } = fixture(t);
  editSubscription(home, '.loadout', 'add', url);
  editSubscription(repo, '.loadout', 'add', url);
  let requests = 0;
  const fetch = async () => {
    requests++;
    return stringify(manifest());
  };
  await refreshCatalogs(repo, { fetch });
  await refreshCatalogs(repo, { fetch });
  await refreshCatalogs(repo, { fetch, force: true, offline: true });
  assert.equal(requests, 1);
  const original = fs.readFileSync(cachePath('catalogs', url));
  const warnings: string[] = [];
  for (const fetch of [
    async () => {
      throw new Error('Disconnected');
    },
    async () => 'schemaVersion: 999',
    async () => stringify(manifest([skill], 'different')),
  ]) {
    await refreshCatalogs(repo, {
      fetch,
      force: true,
      warn: (message) => warnings.push(message),
    });
    assert.deepEqual(fs.readFileSync(cachePath('catalogs', url)), original);
  }
  assert.equal(warnings.length, 3);
  assert.ok(
    warnings.every((message) => message.includes('using cached catalog')),
  );
  assert.ok(loadCatalog(repo).kits.has(skill.id));
});

test('fresh offline catalogs remain unavailable without hiding local kits', async (t) => {
  const { repo } = fixture(t);
  editSubscription(repo, '.loadout', 'add', url);
  put(
    repo,
    '.loadout/kits/local/kit.yaml',
    'schemaVersion: 1\nid: local\ndescription: Local\noutputs:\n  - type: instructions\n    source: instructions.md\n',
  );
  put(repo, '.loadout/kits/local/instructions.md', 'Local instructions');
  const warnings: string[] = [];
  await refreshCatalogs(repo, {
    offline: true,
    warn: (message) => warnings.push(message),
  });
  assert.equal(warnings.length, 1);
  assert.deepEqual([...loadCatalog(repo).kits.keys()], ['local']);
  assert.equal(fs.existsSync(cachePath('catalogs', url)), false);
});

test('corrupt shared caches are disposable and do not block saved installations', async (t) => {
  const { repo, second } = fixture(t);
  editSubscription(repo, '.loadout', 'add', url);
  editSubscription(second, '.loadout', 'add', url);
  cache(manifest([workflow(), skill]));
  let catalog = loadCatalog(repo);
  const state = {
    schemaVersion: 1 as const,
    selected: ['sample-workflow'],
    answers: { 'sample-workflow': { placement: 'context' } },
  };
  apply(
    plan(
      catalog,
      state,
      await renderWithExternal(catalog, state, { fetch: upstream() }),
    ),
  );
  const directory = path.join(process.env.LOADOUT_CACHE_DIR!, 'kits');
  for (const file of fs.readdirSync(directory))
    fs.writeFileSync(path.join(directory, file), '{broken');
  catalog = loadCatalog(repo);
  assert.equal(
    apply(
      plan(
        catalog,
        state,
        await renderWithExternal(catalog, state, {
          offline: true,
          fetch: offline,
        }),
      ),
    ),
    0,
  );
  const uncached = loadCatalog(second);
  await assert.rejects(
    renderWithExternal(uncached, state, { offline: true, fetch: offline }),
    /not available.*offline/,
  );
  await renderWithExternal(uncached, state, { fetch: upstream() });
  fs.writeFileSync(cachePath('catalogs', url), '{broken');
  assert.ok(loadCatalog(repo).kits.get('sample-workflow')?.unavailable);
  await refreshCatalogs(repo, {
    fetch: async () => stringify(manifest([workflow(), skill])),
  });
  assert.equal(
    loadCatalog(repo).kits.get('sample-workflow')?.unavailable,
    undefined,
  );
});

test('unselected remote dependency errors do not hide usable kits', (t) => {
  const { repo } = fixture(t);
  editSubscription(repo, '.loadout', 'add', url);
  const invalid = workflow();
  invalid.source.kit!.manifest.requires = ['missing'];
  cache(manifest([invalid, skill]));
  const catalog = loadCatalog(repo);
  assert.equal(catalog.kits.get('sample-workflow')?.ready, false);
  assert.match(
    catalog.kits.get('sample-workflow')?.problem ?? '',
    /Unknown kit: missing/,
  );
  assert.ok(catalog.kits.has(skill.id));
});

test(
  'resource-backed remote kits do not inspect matching paths in the repository',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { repo, second } = fixture(t);
    editSubscription(repo, '.loadout', 'add', url);
    cache(manifest([workflow(), skill]));
    fs.symlinkSync(second, path.join(repo, 'skills'));
    fs.symlinkSync(
      path.join(second, 'not-needed'),
      path.join(repo, 'instructions.md'),
    );
    const catalog = loadCatalog(repo);
    for (const placement of ['context', 'skill']) {
      const state = {
        schemaVersion: 1 as const,
        selected: ['sample-workflow'],
        answers: { 'sample-workflow': { placement } },
      };
      const rendered = await renderWithExternal(catalog, state, {
        fetch: upstream(),
      });
      assert.ok(
        rendered.files.has(
          placement === 'context'
            ? 'AGENTS.md'
            : '.agents/skills/sample-workflow/SKILL.md',
        ),
      );
    }
  },
);

test('catalog identities and kit collisions are explicit rather than order dependent', (t) => {
  const { repo } = fixture(t);
  const other = 'https://example.com/other.yaml';
  editSubscription(repo, '.loadout', 'add', url);
  editSubscription(repo, '.loadout', 'add', other);
  cache();
  cache(manifest(), other);
  assert.throws(() => loadCatalog(repo), /Catalog ID sample is also published/);
  cache(manifest([skill], 'other'), other);
  assert.throws(() => loadCatalog(repo), /Duplicate kit ID/);
});

test('installed skills survive unsubscribe and disappear from Browse until resubscribed', async (t) => {
  const { repo } = fixture(t);
  editSubscription(repo, '.loadout', 'add', url);
  cache();
  let catalog = loadCatalog(repo);
  const state = {
    schemaVersion: 1 as const,
    selected: [skill.id],
    answers: {},
  };
  apply(
    plan(
      catalog,
      state,
      await renderWithExternal(catalog, state, { fetch: upstream() }),
    ),
  );
  editSubscription(repo, '.loadout', 'remove', url);
  catalog = loadCatalog(repo);
  assert.equal(catalog.kits.get(skill.id)?.unavailable, true);
  assert.equal(catalog.kits.get(skill.id)?.catalog?.id, 'sample');
  assert.equal(
    apply(
      plan(
        catalog,
        state,
        await renderWithExternal(catalog, state, {
          offline: true,
          fetch: offline,
        }),
      ),
    ),
    0,
  );
  const ui = await prompt(targetPicker, { targets: [loadTarget(repo, false)] });
  assert.doesNotMatch(ui.getScreen(), /Sample provider/);
  ui.events.keypress('right');
  assert.match(ui.getScreen(), /sample-helper/);
  continuePicker(ui);
  await ui.answer;
  const disabled = { ...state, selected: [] };
  apply(
    plan(
      catalog,
      disabled,
      await renderWithExternal(catalog, disabled, {
        offline: true,
        fetch: offline,
      }),
    ),
  );
  assert.equal(loadCatalog(repo).kits.has(skill.id), false);
  assert.equal(
    fs.existsSync(path.join(repo, '.agents/skills/sample-helper')),
    false,
  );
});

test('complete remote kits preserve questions, conditions, dependencies, references, and pinned definitions', async (t) => {
  const { repo } = fixture(t);
  editSubscription(repo, '.loadout', 'add', url);
  cache(manifest([workflow(), skill]));
  let catalog = loadCatalog(repo);
  await assert.rejects(
    configure(catalog, {
      schemaVersion: 1,
      selected: ['sample-workflow'],
      answers: {},
    }),
    /missing required answer/,
  );
  const state = await configure(catalog, {
    schemaVersion: 1,
    selected: ['sample-workflow'],
    answers: { 'sample-workflow': { placement: 'context' } },
  });
  apply(
    plan(
      catalog,
      state,
      await renderWithExternal(catalog, state, { fetch: upstream() }),
    ),
  );
  assert.equal(
    fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'),
    'Original guidance\n',
  );
  assert.ok(
    fs.existsSync(path.join(repo, '.agents/skills/sample-helper/SKILL.md')),
  );
  const next = workflow('2'.repeat(40));
  next.source.kit!.manifest.questions.placement!.message = 'New question';
  next.source.kit!.manifest.ready = false;
  cache(manifest([next, skill]));
  catalog = loadCatalog(repo);
  assert.notEqual(catalog.kits.get('sample-workflow')?.ready, false);
  await configure(catalog, state);
  assert.equal(
    catalog.kits.get('sample-workflow')?.questions.placement?.message,
    'Where?',
  );
  assert.equal(availableUpdates(catalog, state.selected).length, 1);
  assert.equal(
    apply(
      plan(
        catalog,
        state,
        await renderWithExternal(catalog, state, {
          offline: true,
          fetch: offline,
        }),
      ),
    ),
    0,
  );
  const updated = catalogForUpdates(catalog, ['sample-workflow']);
  assert.equal(updated.kits.get('sample-workflow')?.ready, false);
  delete next.source.kit!.manifest.ready;
  cache(manifest([next, skill]));
  const ready = catalogForUpdates(loadCatalog(repo), ['sample-workflow']);
  assert.equal(
    updated.kits.get('sample-workflow')?.questions.placement?.message,
    'New question',
  );
  apply(
    plan(
      ready,
      state,
      await renderWithExternal(ready, state, {
        update: ['sample-workflow'],
        fetch: upstream('Updated guidance'),
      }),
    ),
  );
  assert.equal(
    fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'),
    'Updated guidance\n',
  );
  editSubscription(repo, '.loadout', 'remove', url);
  catalog = loadCatalog(repo);
  const asSkill = {
    ...state,
    answers: { 'sample-workflow': { placement: 'skill' } },
  };
  apply(
    plan(
      catalog,
      asSkill,
      await renderWithExternal(catalog, asSkill, {
        offline: true,
        fetch: offline,
      }),
    ),
  );
  assert.equal(fs.existsSync(path.join(repo, 'AGENTS.md')), false);
  assert.equal(
    fs.readFileSync(
      path.join(repo, '.agents/skills/sample-workflow/references/check.md'),
      'utf8',
    ),
    'Supporting reference',
  );
  assert.equal(
    fs.readFileSync(
      path.join(repo, '.agents/skills/sample-workflow/LICENSE.upstream'),
      'utf8',
    ),
    'MIT License',
  );
  assert.equal(catalog.kits.get('sample-helper')?.unavailable, true);
});

test('saved installations cannot be taken over by a different catalog with the same kit ID', async (t) => {
  const { repo } = fixture(t);
  editSubscription(repo, '.loadout', 'add', url);
  cache();
  const catalog = loadCatalog(repo);
  const state = {
    schemaVersion: 1 as const,
    selected: [skill.id],
    answers: {},
  };
  apply(
    plan(
      catalog,
      state,
      await renderWithExternal(catalog, state, { fetch: upstream() }),
    ),
  );
  editSubscription(repo, '.loadout', 'remove', url);
  const other = 'https://example.com/other.yaml';
  editSubscription(repo, '.loadout', 'add', other);
  cache(manifest([skill], 'other'), other);
  assert.throws(
    () => loadCatalog(repo),
    /belongs to catalog sample, not other/,
  );
  editSubscription(repo, '.loadout', 'remove', other);
  put(
    repo,
    '.loadout/kits/local/kit.yaml',
    `schemaVersion: 1\nid: ${skill.id}\ndescription: Local replacement\noutputs:\n  - type: instructions\n    source: instructions.md\n`,
  );
  put(repo, '.loadout/kits/local/instructions.md', 'Unrelated instructions');
  assert.throws(
    () => loadCatalog(repo),
    /belongs to catalog sample, not a local kit/,
  );
  fs.rmSync(path.join(repo, '.loadout/kits/local'), { recursive: true });
  put(
    repo,
    '.loadout-personal/config.yaml',
    stringify({ schemaVersion: 1, externalKits: [skill] }),
  );
  assert.deepEqual(loadCatalog(repo).kits.get(skill.id)?.pinned, skill.source);
  fs.unlinkSync(path.join(repo, '.loadout-personal/config.yaml'));
  const previous = loadCatalog(repo);
  const disabled = { ...state, selected: [] };
  apply(
    plan(
      previous,
      disabled,
      await renderWithExternal(previous, disabled, {
        offline: true,
        fetch: offline,
      }),
    ),
  );
  editSubscription(repo, '.loadout', 'add', other);
  const replacement = loadCatalog(repo);
  assert.equal(replacement.kits.get(skill.id)?.pinned, undefined);
  apply(
    plan(
      replacement,
      state,
      await renderWithExternal(replacement, state, { fetch: upstream() }),
    ),
  );
  assert.equal(
    readExternal(repo).store.kits[skill.id]?.registration?.catalog?.id,
    'other',
  );
});

test('bulk updates remove obsolete dependencies and review both dependency graphs', async (t) => {
  const { home, repo, second } = fixture(t);
  editSubscription(repo, '.loadout', 'add', url);
  editSubscription(second, '.loadout', 'add', url);
  cache(manifest([workflow(), skill]));
  const state = {
    schemaVersion: 1 as const,
    selected: ['sample-workflow'],
    answers: { 'sample-workflow': { placement: 'context' } },
  };
  const installed = loadCatalog(repo);
  apply(
    plan(
      installed,
      state,
      await renderWithExternal(installed, state, { fetch: upstream() }),
    ),
  );

  const next = workflow('2'.repeat(40));
  next.source.kit!.manifest.requires = ['sample-next'];
  const dependency = workflow('2'.repeat(40));
  dependency.id = dependency.source.kit!.manifest.id = 'sample-next';
  dependency.source.kit!.manifest.requires = [];
  dependency.source.kit!.manifest.outputs = [
    { type: 'instructions', source: 'instructions.md', scope: 'next' },
  ];
  dependency.source.kit!.manifest.questions = {};
  cache(
    manifest([
      next,
      { ...skill, source: { ...skill.source, ref: '2'.repeat(40) } },
      dependency,
      { ...skill, id: 'unused' },
    ]),
  );
  fs.mkdirSync(path.join(repo, 'next'));
  fs.mkdirSync(path.join(second, 'next'));
  // Cache the new complete kits without installing them in either destination.
  await renderWithExternal(loadCatalog(second), state, { fetch: upstream() });
  const target = loadTarget(repo, false);
  const catalog = target.catalog!;
  const update = availableUpdates(catalog, state.selected).map((kit) => kit.id);
  assert.deepEqual(update.sort(), ['sample-helper', 'sample-workflow']);
  const updated = catalogForUpdates(catalog, update);
  const rendered = await renderWithExternal(catalog, state, {
    update,
    offline: true,
    fetch: offline,
  });
  const changes = plan(updated, state, rendered);
  assert.deepEqual(
    selectionSummary({ target, state, update }).map(
      ({ id, effect, unchanged }) => [id, effect, unchanged],
    ),
    [
      ['sample-helper', 'Remove', false],
      ['sample-next', 'Add', false],
      ['sample-workflow', 'Update', false],
    ],
  );
  assert.ok(
    changes.changes.some(
      (change) =>
        change.kind === 'delete' &&
        change.path === '.agents/skills/sample-helper/SKILL.md',
    ),
  );
  assert.ok(
    changes.changes.some(
      (change) => change.kind === 'create' && change.path === 'next/AGENTS.md',
    ),
  );
  await assert.rejects(
    renderWithExternal(catalog, state, {
      update: ['unused'],
      offline: true,
      fetch: offline,
    }),
    /Cannot update unused: choose an enabled external kit/,
  );
  const ui = await prompt((_config: object, context?: PromptContext) => {
    if (context?.output) {
      const output = context.output;
      output.end = (() => output) as typeof output.end;
    }
    return interactive([target], 0, { context, fetch: offline });
  }, {});
  continuePicker(ui);
  await ui.nextRender();
  assert.match(ui.getScreen(), /Choose catalog updates/);
  ui.events.keypress('space');
  ui.events.keypress('down');
  ui.events.keypress('space');
  ui.events.keypress('enter');
  await ui.nextRender();
  assert.match(ui.getScreen(), /Change selection/);
  ui.events.keypress('enter');
  await ui.nextRender();
  assert.match(ui.getScreen(), /Remove\s+sample-helper/);
  assert.match(ui.getScreen(), /Add\s+sample-next/);
  const cancelled = assert.rejects(ui.answer, { name: 'ExitPromptError' });
  ui.input.write('\u0003');
  await cancelled;
  const run = (...args: string[]) =>
    promisify(execFile)(
      process.execPath,
      [path.resolve('dist/cli.js'), '-C', repo, '--offline', 'update', ...args],
      { env: { ...process.env, HOME: home, USERPROFILE: home } },
    );
  assert.match((await run('--dry-run')).stdout, /Dry run/);
  assert.ok(fs.existsSync(path.join(repo, '.agents/skills/sample-helper')));
  await run();
  assert.equal(
    fs.existsSync(path.join(repo, '.agents/skills/sample-helper')),
    false,
  );
  assert.equal(
    fs.readFileSync(path.join(repo, 'next/AGENTS.md'), 'utf8'),
    'Original guidance\n',
  );
});

test('complete kits reject skill license collisions before applying outputs', async (t) => {
  const { repo } = fixture(t);
  editSubscription(repo, '.loadout', 'add', url);
  cache(manifest([workflow(), skill]));
  await assert.rejects(
    renderWithExternal(
      loadCatalog(repo),
      {
        schemaVersion: 1,
        selected: ['sample-workflow'],
        answers: { 'sample-workflow': { placement: 'skill' } },
      },
      { fetch: upstream('Original guidance', 'BSD: original skill author') },
    ),
    /Output collision: .*sample-workflow\/LICENSE\.upstream/,
  );
  assert.equal(fs.existsSync(path.join(repo, '.agents')), false);
  assert.equal(
    fs.existsSync(path.join(repo, '.loadout-personal/external.json')),
    false,
  );
});

test('global setup reaches the terminal check despite an invalid repository config', async (t) => {
  const { home, repo } = fixture(t);
  put(repo, '.loadout/config.yaml', 'schemaVersion: 99\n');
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [path.resolve('dist/cli.js'), '-C', repo, '--global', '--offline'],
      {
        env: { ...process.env, HOME: home, USERPROFILE: home },
      },
    ),
    (error: Error & { stderr?: string }) => {
      assert.match(error.stderr ?? '', /Interactive setup needs a terminal/);
      assert.doesNotMatch(error.stderr ?? '', /schemaVersion/);
      return true;
    },
  );
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [path.resolve('dist/cli.js'), '-C', repo, '--offline'],
      { env: { ...process.env, HOME: home, USERPROFILE: home } },
    ),
    (error: Error & { stderr?: string }) => {
      assert.equal(error.stderr?.match(/schemaVersion/g)?.length, 1);
      return true;
    },
  );
});

test('switching between skill collections and complete kits requires an explicit update', async (t) => {
  const { repo } = fixture(t);
  const collection = { ...skill, id: 'sample-workflow' };
  const complete = workflow('2'.repeat(40));
  complete.source.kit!.manifest.requires = [];
  editSubscription(repo, '.loadout', 'add', url);
  cache(manifest([collection]));
  let catalog = loadCatalog(repo);
  const state = {
    schemaVersion: 1 as const,
    selected: ['sample-workflow'],
    answers: { 'sample-workflow': { placement: 'context' } },
  };
  apply(
    plan(
      catalog,
      state,
      await renderWithExternal(catalog, state, { fetch: upstream() }),
    ),
  );
  complete.source.kit!.manifest.ready = false;
  cache(manifest([complete]));
  catalog = loadCatalog(repo);
  assert.notEqual(catalog.kits.get('sample-workflow')?.ready, false);
  assert.deepEqual(catalog.kits.get('sample-workflow')?.outputs, []);
  assert.equal(
    apply(
      plan(
        catalog,
        state,
        await renderWithExternal(catalog, state, {
          offline: true,
          fetch: offline,
        }),
      ),
    ),
    0,
  );
  delete complete.source.kit!.manifest.ready;
  cache(manifest([complete]));
  let updating = catalogForUpdates(loadCatalog(repo), ['sample-workflow']);
  apply(
    plan(
      updating,
      state,
      await renderWithExternal(updating, state, {
        update: ['sample-workflow'],
        fetch: upstream(),
      }),
    ),
  );
  assert.ok(fs.existsSync(path.join(repo, 'AGENTS.md')));
  assert.equal(
    fs.existsSync(path.join(repo, '.agents/skills/sample-helper')),
    false,
  );
  cache(manifest([collection]));
  catalog = loadCatalog(repo);
  assert.equal(
    apply(
      plan(
        catalog,
        state,
        await renderWithExternal(catalog, state, {
          offline: true,
          fetch: offline,
        }),
      ),
    ),
    0,
  );
  updating = catalogForUpdates(catalog, ['sample-workflow']);
  assert.deepEqual(updating.kits.get('sample-workflow')?.outputs, []);
  apply(
    plan(
      updating,
      state,
      await renderWithExternal(updating, state, {
        update: ['sample-workflow'],
        fetch: upstream(),
      }),
    ),
  );
  assert.equal(fs.existsSync(path.join(repo, 'AGENTS.md')), false);
  assert.ok(
    fs.existsSync(path.join(repo, '.agents/skills/sample-helper/SKILL.md')),
  );
});

test('catalog schema validates source choices, duplicate IDs, immutable pins, and URLs', () => {
  for (const address of [
    'file:///etc/passwd',
    'http://example.com/catalog.yaml',
    'https://user:pass@example.com/catalog.yaml',
    'https://example.com/catalog.yaml#fragment',
  ])
    assert.equal(catalogUrlSchema.safeParse(address).success, false);
  assert.equal(
    catalogUrlSchema.safeParse('http://127.0.0.1:8000/catalog.yaml').success,
    true,
  );
  assert.throws(() => manifest([skill, skill]), /Duplicate kit ID/);
  const invalid = workflow();
  invalid.source.skills = ['skills/sample-helper'];
  assert.throws(() => manifest([invalid]), /Choose skill directories/);
  assert.throws(
    () => manifest([{ ...skill, source: { ...skill.source, ref: 'main' } }]),
    /commit SHA/,
  );
  const badCondition = workflow();
  badCondition.source.kit!.manifest.outputs[0]!.when!.answer = 'missing';
  assert.throws(() => manifest([badCondition]), /Invalid condition/);
});

test('kit content hashes ignore repository revisions and reject changed kit contents', async (t) => {
  const { repo } = fixture(t);
  const original = workflow('HEAD');
  original.source.kit!.manifest.requires = [];
  original.source.integrity = await hashSource(original.source, upstream());
  editSubscription(repo, '.loadout', 'add', url);
  cache(manifest([original]));
  let catalog = loadCatalog(repo);
  const state = {
    schemaVersion: 1 as const,
    selected: ['sample-workflow'],
    answers: { 'sample-workflow': { placement: 'context' } },
  };
  apply(
    plan(
      catalog,
      state,
      await renderWithExternal(catalog, state, { fetch: upstream() }),
    ),
  );
  const relocated = structuredClone(original);
  relocated.source.repo = 'example/mirror';
  relocated.source.ref = 'release';
  cache(manifest([relocated]));
  catalog = loadCatalog(repo);
  assert.deepEqual(availableUpdates(catalog), []);
  assert.equal(
    apply(
      plan(
        catalog,
        state,
        await renderWithExternal(catalog, state, {
          offline: true,
          fetch: offline,
        }),
      ),
    ),
    0,
  );
  const changed = structuredClone(relocated);
  changed.source.integrity = await hashSource(
    changed.source,
    upstream('New content'),
  );
  assert.notEqual(changed.source.integrity, original.source.integrity);
  cache(manifest([changed]));
  catalog = loadCatalog(repo);
  assert.equal(availableUpdates(catalog).length, 1);
  const update = ['sample-workflow'];
  await assert.rejects(
    renderWithExternal(catalog, state, {
      update,
      fetch: upstream('Unexpected third version'),
    }),
    /kit content hash mismatch/,
  );
  assert.equal(
    fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'),
    'Original guidance\n',
  );
  const updated = catalogForUpdates(catalog, update);
  apply(
    plan(
      updated,
      state,
      await renderWithExternal(updated, state, {
        update,
        fetch: upstream('New content'),
      }),
    ),
  );
  assert.equal(
    fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'),
    'New content\n',
  );
});

test('migrating identical installed content from commit pins to hashes does not offer an update', async (t) => {
  const { repo } = fixture(t);
  editSubscription(repo, '.loadout', 'add', url);
  cache();
  const state = {
    schemaVersion: 1 as const,
    selected: [skill.id],
    answers: {},
  };
  const catalog = loadCatalog(repo);
  apply(
    plan(
      catalog,
      state,
      await renderWithExternal(catalog, state, { fetch: upstream() }),
    ),
  );
  const hashed = structuredClone(skill);
  hashed.source.ref = 'HEAD';
  hashed.source.integrity = await hashSource(hashed.source, upstream());
  cache(manifest([hashed]));
  assert.deepEqual(availableUpdates(loadCatalog(repo)), []);
  assert.deepEqual(availableUpdates(loadTarget(repo, false).catalog!), []);
  assert.equal(
    readExternal(repo).store.kits[skill.id]?.source.integrity,
    undefined,
  );
});

test('CLI adds multiple catalogs atomically and distinguishes all three configuration scopes', async (t) => {
  const { home, repo, second } = fixture(t);
  const requests = new Map<string, number>();
  const server = http.createServer((request, response) => {
    requests.set(request.url!, (requests.get(request.url!) ?? 0) + 1);
    response.end(
      stringify(
        request.url === '/other.yaml' ? manifest([], 'other') : manifest(),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/catalog.yaml`;
  const other = new URL('other.yaml', address).href;
  const run = async (root: string, ...args: string[]) =>
    (
      await promisify(execFile)(
        process.execPath,
        [path.resolve('dist/cli.js'), '-C', root, ...args],
        { env: { ...process.env, HOME: home, USERPROFILE: home } },
      )
    ).stdout;
  const config = path.join(home, '.loadout/config.yaml');
  const before = fs.readFileSync(config);
  await assert.rejects(
    run(
      repo,
      'catalog',
      'add',
      address,
      'http://example.com/invalid.yaml',
      '--personal',
    ),
    /Use an HTTPS manifest URL/,
  );
  assert.deepEqual(fs.readFileSync(config), before);
  assert.equal(requests.size, 0);
  assert.match(
    await run(repo, 'catalog', 'add', address, other, address, '--personal'),
    /Added/,
  );
  assert.deepEqual(
    subscriptions(home, true).map(({ url }) => url),
    [address, other],
  );
  assert.match(
    await run(repo, 'catalog', 'add', address, other, '--personal'),
    /No change/,
  );
  assert.deepEqual(
    [...requests],
    [
      ['/catalog.yaml', 1],
      ['/other.yaml', 1],
    ],
  );
  assert.match(
    await run(second, '--offline', 'list'),
    /sample-helper \[disabled\]/,
  );
  assert.match(
    await run(home, '--global', '--offline', 'list'),
    /sample-helper/,
  );
  await run(repo, 'catalog', 'add', address);
  await run(repo, 'catalog', 'add', address, other, '--private');
  assert.match(
    await run(repo, 'catalog', 'list'),
    /Personal, Repository, Repository private/,
  );
  assert.match(
    fs.readFileSync(path.join(repo, '.loadout/config.yaml'), 'utf8'),
    /catalogs:/,
  );
  await run(repo, 'catalog', 'remove', address, other, '--personal');
  assert.doesNotMatch(await run(second, '--offline', 'list'), /sample-helper/);
  assert.match(await run(repo, '--offline', 'list'), /sample-helper/);
  assert.ok(readCatalogCache(address));
  assert.ok(readCatalogCache(other));
  assert.equal(fs.existsSync(path.join(repo, '.agents')), false);
  assert.equal(
    subscriptions(repo).some((entry) => entry.url === officialCatalogUrl),
    false,
  );
});
