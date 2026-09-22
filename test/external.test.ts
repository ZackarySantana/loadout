import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { stringify } from 'yaml';
import { initialize } from './examples.js';
import { loadCatalog } from '../src/catalog.js';
import { loadState, apply, plan } from '../src/storage.js';
import { configure } from '../src/resolve.js';
import {
  renderWithExternal,
  readExternal,
  type FetchBytes,
  type SnapshotCache,
} from '../src/external.js';
import {
  externalSourceSchema,
  sameSource,
  type ExternalSource,
} from '../src/schema.js';
import { DownloadCancelledError } from '../src/retry.js';

const revision = '1'.repeat(40);
const source: ExternalSource = {
  repo: 'acme/skills',
  ref: revision,
  skills: ['skills/alpha'],
  license: 'LICENSE',
};
const blobHash = (content: Buffer) =>
  createHash('sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');
function fixture(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-external-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initialize(root);
  config(root);
  return root;
}
function config(root: string, ref = revision): void {
  fs.writeFileSync(
    path.join(root, '.loadout/config.yaml'),
    stringify({
      schemaVersion: 1,
      externalKits: [
        {
          id: 'acme-alpha',
          description: 'External alpha workflow',
          source: { ...source, ref },
        },
      ],
    }),
  );
}
function upstream(
  body = '# Alpha\n',
): Map<string, { content: Buffer; mode: string }> {
  return new Map([
    [
      'LICENSE',
      { content: Buffer.from('MIT License\nCopyright Acme\n'), mode: '100644' },
    ],
    [
      'skills/alpha/SKILL.md',
      {
        content: Buffer.from(
          `---\nname: alpha\ndescription: Alpha workflow\n---\n${body}`,
        ),
        mode: '100644',
      },
    ],
    [
      'skills/alpha/references/details.md',
      { content: Buffer.from('Details'), mode: '100644' },
    ],
    [
      'skills/alpha/scripts/check.sh',
      { content: Buffer.from('#!/bin/sh\nexit 0\n'), mode: '100755' },
    ],
    [
      'skills/alpha/image.bin',
      { content: Buffer.from([0, 255, 1]), mode: '100644' },
    ],
  ]);
}
function mockFetch(files = upstream(), requests: string[] = []): FetchBytes {
  return async (url) => {
    requests.push(url);
    if (url.startsWith('https://api.github.com/'))
      return Buffer.from(
        JSON.stringify({
          truncated: false,
          tree: [...files].map(([name, file]) => ({
            path: name,
            type: 'blob',
            mode: file.mode,
            size: file.content.length,
            sha: blobHash(file.content),
          })),
        }),
      );
    const file = decodeURIComponent(
      new URL(url).pathname.split('/').slice(4).join('/'),
    );
    assert.ok(files.has(file), `Unexpected URL: ${url}`);
    return files.get(file)!.content;
  };
}
const offlineFetch: FetchBytes = async () => {
  throw new Error('Unexpected network access');
};

test('mapped upstream skill names preserve content, resources, licenses, and offline snapshots', async (t) => {
  const root = fixture(t);
  const mapped = {
    ...source,
    skillNames: { 'skills/alpha': 'acme-alpha' },
    license: 'README.md',
  };
  fs.writeFileSync(
    path.join(root, '.loadout/config.yaml'),
    stringify({
      schemaVersion: 1,
      externalKits: [
        { id: 'acme-alpha', description: 'Mapped skill', source: mapped },
      ],
    }),
  );
  const files = upstream();
  const skill = files.get('skills/alpha/SKILL.md')!;
  skill.content = Buffer.from(
    skill.content.toString().replace('name: alpha', 'name: acme-alpha'),
  );
  files.set('README.md', files.get('LICENSE')!);
  files.delete('LICENSE');
  apply(await prepare(root, ['acme-alpha'], mockFetch(files)));
  for (const agent of ['.agents', '.claude']) {
    const directory = path.join(root, agent, 'skills/acme-alpha');
    assert.deepEqual(
      fs.readFileSync(path.join(directory, 'SKILL.md')),
      skill.content,
    );
    assert.equal(
      fs.readFileSync(path.join(directory, 'references/details.md'), 'utf8'),
      'Details',
    );
    assert.match(
      fs.readFileSync(path.join(directory, 'LICENSE.upstream'), 'utf8'),
      /MIT License/,
    );
    assert.equal(fs.existsSync(path.join(root, agent, 'skills/alpha')), false);
  }
  const offline = await prepare(
    root,
    ['acme-alpha'],
    offlineFetch,
    undefined,
    true,
  );
  assert.ok(offline.changes.every((change) => change.kind === 'unchanged'));
  const snapshot = readExternal(root).store;
  snapshot.kits['acme-alpha']!.source.skillNames!['skills/alpha'] = 'tampered';
  fs.writeFileSync(
    path.join(root, '.loadout-personal/external.json'),
    JSON.stringify(snapshot),
  );
  await assert.rejects(
    prepare(root, ['acme-alpha'], offlineFetch, undefined, true),
    /manifest checksum mismatch/,
  );
});

test('skill name mappings are validated and distinguish source revisions and session caches', async (t) => {
  assert.equal(
    externalSourceSchema.safeParse({
      ...source,
      skillNames: { 'skills/other': 'other' },
    }).success,
    false,
  );
  assert.equal(
    externalSourceSchema.safeParse({
      ...source,
      skillNames: { 'skills/alpha': '../escape' },
    }).success,
    false,
  );
  const mapped = { ...source, skillNames: { 'skills/alpha': 'acme-alpha' } };
  assert.equal(sameSource(source, mapped), false);
  assert.equal(
    sameSource(source, { ...source, skillNames: { 'skills/alpha': 'alpha' } }),
    true,
  );
  const root = fixture(t);
  const catalog = loadCatalog(root);
  const state = { ...loadState(catalog), selected: ['acme-alpha'] };
  const cache: SnapshotCache = new Map();
  await renderWithExternal(catalog, state, { cache, fetch: mockFetch() });
  catalog.kits.get('acme-alpha')!.external = mapped;
  const files = upstream();
  files.get('skills/alpha/SKILL.md')!.content = Buffer.from(
    '---\nname: acme-alpha\ndescription: Mapped skill\n---\n',
  );
  const result = await renderWithExternal(catalog, state, {
    cache,
    fetch: mockFetch(files),
  });
  assert.ok(result.files.has('.agents/skills/acme-alpha/SKILL.md'));
  assert.equal(cache.size, 2);
  catalog.kits.get('acme-alpha')!.external = {
    ...source,
    skills: ['skills/alpha', 'skills/beta'],
    skillNames: { 'skills/beta': 'alpha' },
  };
  await assert.rejects(
    renderWithExternal(catalog, state, { fetch: offlineFetch }),
    /duplicate skill names/,
  );
});

test('session snapshots reuse exact sources across preparation and scopes without saving them', async (t) => {
  const root = fixture(t);
  const catalog = loadCatalog(root);
  const state = { ...loadState(catalog), selected: ['acme-alpha'] };
  const cache: SnapshotCache = new Map();
  const requests: string[] = [];
  const first = await renderWithExternal(catalog, state, {
    cache,
    fetch: mockFetch(upstream(), requests),
  });
  assert.ok(requests.length > 0);
  const count = requests.length;
  const ready: string[] = [];
  const second = await renderWithExternal(catalog, state, {
    cache,
    fetch: offlineFetch,
    onReady: (id) => ready.push(id),
    onFetch: () => assert.fail('cached kits must not say Downloading'),
  });
  assert.deepEqual(second, first);
  assert.deepEqual(ready, ['acme-alpha']);
  assert.equal(
    fs.existsSync(path.join(root, '.loadout-personal/external.json')),
    false,
  );
  const other = fixture(t);
  const crossScope = await renderWithExternal(loadCatalog(other), state, {
    cache,
    fetch: offlineFetch,
  });
  assert.deepEqual(crossScope.files, first.files);
  config(root, '2'.repeat(40));
  await renderWithExternal(loadCatalog(root), state, {
    cache,
    fetch: mockFetch(upstream(), requests),
  });
  assert.ok(
    requests.length > count,
    'a different revision must download again',
  );
  assert.equal(cache.size, 2);
});

test('aborted preparation does not retry or retain a partial snapshot', async (t) => {
  const root = fixture(t);
  const catalog = loadCatalog(root);
  const state = { ...loadState(catalog), selected: ['acme-alpha'] };
  const cache: SnapshotCache = new Map();
  const controller = new AbortController();
  const reason = new Error('Back to selections');
  let calls = 0;
  await assert.rejects(
    renderWithExternal(catalog, state, {
      cache,
      signal: controller.signal,
      fetch: async () => {
        calls++;
        controller.abort(reason);
        throw reason;
      },
      onRetry: () => assert.fail('abort must not retry'),
    }),
    reason,
  );
  assert.equal(calls, 1);
  assert.equal(cache.size, 0);
  assert.equal(
    fs.existsSync(path.join(root, '.loadout-personal/external.json')),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(root, '.loadout-personal/local.json')),
    false,
  );
});

test('cancelling a failed download aborts pending requests and saves none of the completed kits', async (t) => {
  const root = fixture(t);
  fs.writeFileSync(
    path.join(root, '.loadout/config.yaml'),
    stringify({
      schemaVersion: 1,
      curated: false,
      externalKits: [
        { id: 'acme-alpha', description: 'First kit', source },
        {
          id: 'acme-beta',
          description: 'Second kit',
          source: { ...source, repo: 'acme/other' },
        },
      ],
    }),
  );
  const catalog = loadCatalog(root);
  const state = await configure(catalog, {
    ...loadState(catalog),
    selected: ['acme-alpha', 'acme-beta'],
  });
  let attempts = 0,
    pending = 0,
    aborted = 0,
    prompts = 0;
  const completeFetch = mockFetch();
  const failingFetch: FetchBytes = async (url, limit, signal) => {
    if (!url.includes('/acme/other/')) return completeFetch(url, limit);
    if (url.includes('api.github.com')) {
      attempts++;
      return completeFetch(url, limit);
    }
    if (url.endsWith('/SKILL.md')) throw new Error('Connection lost');
    pending++;
    return new Promise((_resolve, reject) => {
      signal!.addEventListener(
        'abort',
        () => {
          pending--;
          aborted++;
          reject(new Error('Aborted'));
        },
        { once: true },
      );
    });
  };
  await assert.rejects(
    renderWithExternal(catalog, state, {
      fetch: failingFetch,
      retry: async (id) => {
        assert.equal(id, 'acme-beta');
        assert.equal(pending, 0);
        prompts++;
        return false;
      },
    }),
    DownloadCancelledError,
  );
  assert.equal(attempts, 2);
  assert.equal(prompts, 1);
  assert.ok(aborted > 0);
  assert.equal(pending, 0);
  assert.equal(
    fs.existsSync(path.join(root, '.loadout-personal/external.json')),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(root, '.loadout-personal/local.json')),
    false,
  );
  assert.equal(fs.existsSync(path.join(root, '.agents')), false);
  assert.equal(fs.existsSync(path.join(root, '.claude')), false);
});
async function prepare(
  root: string,
  selected = ['acme-alpha'],
  fetch: FetchBytes = mockFetch(),
  update?: string[],
  offline = false,
) {
  const catalog = loadCatalog(root);
  const state = await configure(catalog, { ...loadState(catalog), selected });
  const rendered = await renderWithExternal(catalog, state, {
    fetch,
    update,
    offline,
  });
  return plan(catalog, state, rendered);
}

test('catalog offers optional attributed recommendations without network access', async (t) => {
  const root = fixture(t);
  const catalog = loadCatalog(root);
  const grill = catalog.kits.get('matt-pocock-grill-me')!;
  assert.equal(grill.origin, 'curated');
  assert.deepEqual(grill.external?.skills, [
    'skills/productivity/grill-me',
    'skills/productivity/grilling',
  ]);
  assert.equal(catalog.kits.get('acme-alpha')?.external?.repo, 'acme/skills');
  const preview = await prepare(root, ['testing'], offlineFetch);
  assert.ok(preview.changes.every((c) => !c.path.includes('alpha')));
  assert.equal(
    fs.existsSync(path.join(root, '.loadout-personal/external.json')),
    false,
  );
});

test('preview fetches in memory; apply saves complete verified skills, license, and offline snapshot', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['init', '-q', root]);
  const requests: string[] = [];
  const preview = await prepare(
    root,
    ['acme-alpha'],
    mockFetch(upstream(), requests),
  );
  assert.ok(requests.some((url) => url.includes(revision)));
  assert.equal(
    fs.existsSync(path.join(root, '.loadout-personal/external.json')),
    false,
  );
  assert.equal(fs.existsSync(path.join(root, '.agents/skills/alpha')), false);
  apply(preview);
  for (const agent of ['.agents', '.claude']) {
    assert.match(
      fs.readFileSync(
        path.join(root, `${agent}/skills/alpha/SKILL.md`),
        'utf8',
      ),
      /# Alpha/,
    );
    assert.equal(
      fs.readFileSync(
        path.join(root, `${agent}/skills/alpha/LICENSE.upstream`),
        'utf8',
      ),
      'MIT License\nCopyright Acme\n',
    );
    assert.equal(
      fs.readFileSync(
        path.join(root, `${agent}/skills/alpha/references/details.md`),
        'utf8',
      ),
      'Details',
    );
    assert.deepEqual(
      fs.readFileSync(path.join(root, `${agent}/skills/alpha/image.bin`)),
      Buffer.from([0, 255, 1]),
    );
    if (process.platform !== 'win32')
      assert.equal(
        fs.statSync(path.join(root, `${agent}/skills/alpha/scripts/check.sh`))
          .mode & 0o777,
        0o755,
      );
  }
  assert.equal(
    readExternal(root).store.kits['acme-alpha']?.source.ref,
    revision,
  );
  assert.match(
    execFileSync(
      'git',
      ['-C', root, 'check-ignore', '.loadout-personal/external.json'],
      { encoding: 'utf8' },
    ),
    /external.json/,
  );
  assert.equal(
    apply(await prepare(root, ['acme-alpha'], offlineFetch, undefined, true)),
    0,
  );
});

test('offered revisions stay pinned until explicit update, and disabling works offline', async (t) => {
  const root = fixture(t);
  apply(await prepare(root));
  config(root, '2'.repeat(40));
  assert.equal(apply(await prepare(root, ['acme-alpha'], offlineFetch)), 0);
  const update = await prepare(
    root,
    ['acme-alpha'],
    mockFetch(upstream('# Revised\n')),
    ['acme-alpha'],
  );
  assert.match(
    fs.readFileSync(path.join(root, '.agents/skills/alpha/SKILL.md'), 'utf8'),
    /# Alpha/,
  );
  assert.ok(
    update.changes.some(
      (c) => c.path === '.agents/skills/alpha/SKILL.md' && c.kind === 'update',
    ),
  );
  apply(update);
  assert.equal(
    readExternal(root).store.kits['acme-alpha']?.source.ref,
    '2'.repeat(40),
  );
  assert.match(
    fs.readFileSync(path.join(root, '.agents/skills/alpha/SKILL.md'), 'utf8'),
    /# Revised/,
  );
  apply(await prepare(root, [], offlineFetch));
  assert.equal(fs.existsSync(path.join(root, '.agents/skills/alpha')), false);
  assert.equal(fs.existsSync(path.join(root, '.claude/skills/alpha')), false);
  assert.deepEqual(loadState(loadCatalog(root)).selected, []);
  assert.ok(
    readExternal(root).store.kits['acme-alpha'],
    'only the internal snapshot cache remains',
  );
  apply(await prepare(root, ['acme-alpha'], offlineFetch));
});

test('offline cache misses and network failures leave no state or output', async (t) => {
  const root = fixture(t);
  await assert.rejects(
    prepare(root, ['acme-alpha'], offlineFetch, undefined, true),
    /not available.*offline/,
  );
  await assert.rejects(
    prepare(root, ['acme-alpha'], async () => {
      throw new Error('Network unavailable');
    }),
    /Network unavailable/,
  );
  assert.equal(
    fs.existsSync(path.join(root, '.loadout-personal/external.json')),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(root, '.loadout-personal/local.json')),
    false,
  );
  assert.equal(fs.existsSync(path.join(root, '.agents')), false);
});

test('remote checksum failures, traversal, symlinks, and oversized files fail before apply', async (t) => {
  const root = fixture(t);
  const valid = mockFetch();
  await assert.rejects(
    prepare(root, ['acme-alpha'], (url, limit) =>
      url.includes('raw.githubusercontent')
        ? Promise.resolve(Buffer.from('tampered'))
        : valid(url, limit),
    ),
    /checksum mismatch/,
  );
  for (const [name, mode, expected] of [
    ['skills/alpha/../../escape', '100644', /relative path/],
    ['skills/alpha/link', '120000', /symlink or submodule/],
  ] as const) {
    const files = upstream();
    files.set(name, { mode, content: Buffer.from('bad') });
    await assert.rejects(
      prepare(root, ['acme-alpha'], mockFetch(files)),
      expected,
    );
  }
  const files = upstream();
  files.set('skills/alpha/huge', {
    mode: '100644',
    content: Buffer.alloc(2 * 1024 * 1024 + 1),
  });
  await assert.rejects(
    prepare(root, ['acme-alpha'], mockFetch(files)),
    /size limits/,
  );
  assert.equal(fs.existsSync(path.join(root, '.agents')), false);
});

test('external source schema rejects branch pins and duplicate kit IDs', (t) => {
  const root = fixture(t);
  config(root, 'main');
  assert.throws(() => loadCatalog(root), /full 40-character/);
  fs.writeFileSync(
    path.join(root, '.loadout/config.yaml'),
    stringify({
      schemaVersion: 1,
      externalKits: [{ id: 'testing', description: 'Collision', source }],
    }),
  );
  assert.throws(() => loadCatalog(root), /Duplicate kit ID/);
});

test('local and external output collisions preserve existing files', async (t) => {
  const root = fixture(t);
  const dir = path.join(root, '.loadout/kits/local-alpha');
  fs.mkdirSync(path.join(dir, 'alpha'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'kit.yaml'),
    stringify({
      schemaVersion: 1,
      id: 'local-alpha',
      description: 'Local',
      outputs: [{ type: 'skill', source: 'alpha' }],
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'alpha/SKILL.md'),
    upstream().get('skills/alpha/SKILL.md')!.content,
  );
  await assert.rejects(
    prepare(root, ['local-alpha', 'acme-alpha']),
    /Output collision/,
  );
  assert.equal(fs.existsSync(path.join(root, '.agents')), false);
});

test('modified outputs and corrupt snapshots block updates', async (t) => {
  const root = fixture(t);
  apply(await prepare(root));
  const snapshotBefore = fs.readFileSync(
    path.join(root, '.loadout-personal/external.json'),
  );
  fs.appendFileSync(
    path.join(root, '.agents/skills/alpha/SKILL.md'),
    'Manual edit',
  );
  await assert.rejects(
    prepare(root, ['acme-alpha'], mockFetch(), ['acme-alpha']),
    /manually modified/,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(root, '.loadout-personal/external.json')),
    snapshotBefore,
  );
  const corrupted = JSON.parse(snapshotBefore.toString());
  corrupted.kits['acme-alpha'].files['alpha/SKILL.md'].data =
    Buffer.from('bad').toString('base64');
  fs.writeFileSync(
    path.join(root, '.loadout-personal/external.json'),
    JSON.stringify(corrupted),
  );
  await assert.rejects(
    prepare(root, ['acme-alpha'], offlineFetch),
    /checksum mismatch/,
  );
});

test('curated opt-out leaves only repository-defined kits', (t) => {
  const root = fixture(t);
  fs.writeFileSync(
    path.join(root, '.loadout/config.yaml'),
    'schemaVersion: 1\ncurated: false\n',
  );
  assert.deepEqual(
    [...loadCatalog(root).kits.keys()],
    ['code-navigation', 'graphiffy', 'testing'],
  );
});

test('a repo can pin a curated kit explicitly without duplicate definitions', (t) => {
  const root = fixture(t);
  fs.writeFileSync(
    path.join(root, '.loadout/config.yaml'),
    stringify({
      schemaVersion: 1,
      externalKits: [
        { id: 'matt-pocock-grill-me', description: 'Our version', source },
      ],
    }),
  );
  const kit = loadCatalog(root).kits.get('matt-pocock-grill-me')!;
  assert.equal(kit.origin, 'external');
  assert.equal(kit.external?.repo, 'acme/skills');
});

test('offline snapshot completeness and concurrent snapshot edits are checked', async (t) => {
  const root = fixture(t);
  apply(await prepare(root));
  const file = path.join(root, '.loadout-personal/external.json');
  const original = fs.readFileSync(file);
  const missing = JSON.parse(original.toString());
  delete missing.kits['acme-alpha'].files['alpha/references/details.md'];
  fs.writeFileSync(file, JSON.stringify(missing));
  await assert.rejects(
    prepare(root, ['acme-alpha'], offlineFetch),
    /manifest checksum mismatch/,
  );
  fs.writeFileSync(file, original);
  const catalog = loadCatalog(root);
  const state = loadState(catalog);
  const rendered = await renderWithExternal(catalog, state, {
    fetch: offlineFetch,
  });
  fs.appendFileSync(file, '\n');
  assert.throws(() => plan(catalog, state, rendered), /snapshots changed/);
});

test('CLI reports changed catalog pins without fetching, and bulk updates honor offline mode', async (t) => {
  const root = fixture(t);
  apply(await prepare(root));
  config(root, '2'.repeat(40));
  const cli = new URL('../dist/cli.js', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  const run = (args: string[]) =>
    spawnSync(process.execPath, [fileURLToPath(cli), '-C', root, ...args], {
      encoding: 'utf8',
      timeout: 10000,
    });
  const before = readExternal(root).raw;
  const status = run(['--offline', 'outdated']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /acme-alpha/);
  assert.match(status.stdout, /111111111111 → acme\/skills@222222222222/);
  assert.match(status.stdout, /upstream branches were not checked/);
  const update = run(['--offline', 'update', '--dry-run']);
  assert.equal(update.status, 1);
  assert.match(update.stderr, /not available.*offline/);
  assert.deepEqual(readExternal(root).raw, before);
  apply(await prepare(root, [], offlineFetch));
  assert.match(run(['outdated']).stdout, /acme-alpha \[disabled\]/);
  assert.match(
    run(['--offline', 'update']).stdout,
    /No catalog updates for enabled/,
  );
});

test('one selection installs both repository instructions and browsed external skills', async (t) => {
  const root = fixture(t);
  apply(await prepare(root, ['testing', 'acme-alpha']));
  assert.match(
    fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
    /# Testing/,
  );
  for (const agent of ['.agents', '.claude'])
    assert.match(
      fs.readFileSync(path.join(root, agent, 'skills/alpha/SKILL.md'), 'utf8'),
      /# Alpha/,
    );
  assert.deepEqual(loadState(loadCatalog(root)).selected, [
    'acme-alpha',
    'testing',
  ]);
});
