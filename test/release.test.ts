import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { render as prompt } from '@inquirer/testing';
import { initialize } from '../src/init.js';
import { installExamples } from './examples.js';
import { loadCatalog } from '../src/catalog.js';
import { loadTarget } from '../src/targets.js';
import { targetPicker } from '../src/picker.js';
import { configure, resolveKits } from '../src/resolve.js';
import { render } from '../src/render.js';
import { apply, applyAll, loadState, plan } from '../src/storage.js';
import { walk } from '../src/fs.js';
import { configSchema, stateSchema } from '../src/schema.js';
import { retryDownload, DownloadCancelledError } from '../src/retry.js';
import { confirmRetry, confirmAdoption } from '../src/interactive.js';

function fixture(t: TestContext, global = false, examples = true): string {
  // Storage's tracked-file probe is stubbed: these tests never execute Git.
  t.mock.method(childProcess, 'execFileSync', () => '');
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initialize(root, global);
  if (examples) installExamples(root);
  return root;
}
function put(root: string, file: string, bytes: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), bytes);
}
function read(root: string, file: string): Buffer {
  return fs.readFileSync(path.join(root, file));
}
function snapshot(root: string) {
  return Object.fromEntries(
    walk(root).map((file) => [file, read(root, file).toString('base64')]),
  );
}
async function prepare(
  root: string,
  selected: string[],
  global = false,
  adopt = true,
) {
  const catalog = loadCatalog(root, global);
  const state = await configure(catalog, { ...loadState(catalog), selected });
  return plan(catalog, state, render(catalog, state), { adopt });
}

test('init supplies one unfinished starter; unfinished kits stay last and cannot be selected', async (t) => {
  const root = fixture(t, false, false);
  const catalog = loadCatalog(root);
  assert.deepEqual(
    [...catalog.kits.values()]
      .filter((kit) => !kit.origin)
      .map((kit) => kit.id),
    ['starter'],
  );
  assert.equal(catalog.kits.get('starter')?.ready, false);
  assert.throws(() => resolveKits(catalog, ['starter']), /needs setup/);
  // Unfinished kits can reference files and dependencies that do not exist yet.
  put(
    root,
    '.loadout/kits/starter/kit.yaml',
    'schemaVersion: 1\nid: starter\ndescription: Work in progress\nready: false\nrequires: [future]\noutputs:\n  - type: skill\n    source: missing\n',
  );
  put(
    root,
    '.loadout/kits/z-ready/kit.yaml',
    'schemaVersion: 1\nid: z-ready\ndescription: Ready\noutputs:\n  - type: instructions\n    source: instructions.md\n',
  );
  put(root, '.loadout/kits/z-ready/instructions.md', 'Ready instructions.\n');
  const ui = await prompt(targetPicker, {
    targets: [loadTarget(root, false)],
    columns: 90,
    rows: 30,
  });
  assert.ok(
    ui.getScreen().indexOf('z-ready') < ui.getScreen().indexOf('starter'),
  );
  assert.match(ui.getScreen(), /Needs setup/);
  assert.doesNotMatch(ui.getScreen(), /invalid/i);
  ui.events.keypress('down');
  ui.events.keypress('space');
  ui.events.keypress('enter');
  assert.match(ui.getScreen(), /0 selected/);
  ui.events.keypress('down');
  ui.events.keypress('enter');
  assert.deepEqual((await ui.answer)[0]!.state.selected, []);
  put(
    root,
    '.loadout/kits/starter/kit.yaml',
    'schemaVersion: 1\nid: starter\ndescription: Work in progress\nready: false\n',
  );
  assert.equal(loadCatalog(root).kits.get('starter')?.outputs.length, 0);
  put(
    root,
    '.loadout/kits/starter/kit.yaml',
    'schemaVersion: 1\nid: starter\ndescription: Ready\nready: true\n',
  );
  assert.throws(() => loadCatalog(root), /at least one output/);
});

test('schemas reject removed agent preferences', () => {
  assert.equal(
    configSchema.safeParse({ schemaVersion: 1, agents: ['codex'] }).success,
    false,
  );
  assert.equal(
    stateSchema.safeParse({
      schemaVersion: 1,
      selected: [],
      answers: {},
      agents: ['claude'],
    }).success,
    false,
  );
});

test('disabling scoped instructions preserves empty repository directories and allows re-enabling', async (t) => {
  const root = fixture(t, false, false);
  fs.mkdirSync(path.join(root, 'packages/ui'), { recursive: true });
  put(
    root,
    '.loadout/kits/scoped/kit.yaml',
    `schemaVersion: 1
id: scoped
description: Scoped guidance
outputs:
  - type: instructions
    source: instructions.md
    scope: packages/ui
`,
  );
  put(root, '.loadout/kits/scoped/instructions.md', 'UI guidance.\n');
  apply(await prepare(root, ['scoped']));
  assert.equal(
    read(root, 'packages/ui/AGENTS.md').toString(),
    'UI guidance.\n',
  );
  apply(await prepare(root, []));
  assert.deepEqual(fs.readdirSync(path.join(root, 'packages/ui')), []);
  apply(await prepare(root, ['scoped']));
  assert.equal(read(root, 'packages/ui/CLAUDE.md').toString(), '@AGENTS.md\n');
});

test('rolling back scoped instructions preserves the original empty directory', async (t) => {
  const root = fixture(t, false, false);
  fs.mkdirSync(path.join(root, 'src'));
  put(
    root,
    '.loadout/kits/scoped/kit.yaml',
    `schemaVersion: 1
id: scoped
description: Scoped guidance
outputs:
  - type: instructions
    source: instructions.md
    scope: src
`,
  );
  put(root, '.loadout/kits/scoped/instructions.md', 'Source guidance.\n');
  const preview = await prepare(root, ['scoped']);
  const before = snapshot(root);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === path.join(root, '.loadout/local.json'))
      throw new Error('Simulated metadata write failure');
    return rename(from, to);
  });
  assert.throws(() => apply(preview), /Simulated metadata write failure/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'src')), []);
  assert.deepEqual(snapshot(root), before);
  assert.ok(loadCatalog(root).kits.has('scoped'));
});

test('adoption previews preserve content, reuse Claude imports, update once, and restore originals in both scopes', async (t) => {
  for (const global of [false, true]) {
    const root = fixture(t, global);
    const agents = global ? '.codex/AGENTS.md' : 'AGENTS.md';
    const claude = global ? '.claude/CLAUDE.md' : 'CLAUDE.md';
    const original = Buffer.from(
      '\ufeff# My guidance\r\n\r\nKeep this text.\r\n',
    );
    const importText = global ? '@../.codex/AGENTS.md' : '  @./AGENTS.md  ';
    const claudeOriginal = Buffer.from(
      `# Claude-specific\r\n${importText}\r\n`,
    );
    put(root, agents, original);
    put(root, claude, claudeOriginal);
    const before = snapshot(root);
    await assert.rejects(
      prepare(root, ['testing'], global, false),
      /Unmanaged file/,
    );
    const preview = await prepare(root, ['testing'], global);
    assert.deepEqual(preview.adopted?.sort(), [agents, claude].sort());
    assert.deepEqual(snapshot(root), before);
    apply(preview);
    assert.ok(read(root, agents).subarray(0, original.length).equals(original));
    assert.doesNotMatch(read(root, agents).toString(), /(?<!\r)\n/);
    assert.deepEqual(read(root, claude), claudeOriginal);
    assert.equal(apply(await prepare(root, ['testing'], global)), 0);
    apply(await prepare(root, ['testing', 'code-navigation'], global));
    assert.equal(
      read(root, agents).toString().split('Keep this text.').length,
      2,
    );
    apply(await prepare(root, [], global));
    assert.deepEqual(read(root, agents), original);
    assert.deepEqual(read(root, claude), claudeOriginal);
    assert.equal(
      fs.existsSync(path.join(root, '.loadout/adopted.json')),
      false,
    );
    assert.equal(fs.existsSync(path.join(root, '.loadout/adopted')), false);
    assert.deepEqual(
      JSON.parse(read(root, '.loadout/generated.json').toString()).files,
      {},
    );
    assert.doesNotMatch(
      read(root, '.gitignore').toString(),
      /^\/(?:\.codex\/)?AGENTS.md$/m,
    );
  }
});

test('adoption preserves Claude-specific text and adds its missing import once', async (t) => {
  const root = fixture(t);
  put(root, 'CLAUDE.md', '# My Claude preferences');
  apply(await prepare(root, ['testing']));
  assert.equal(
    read(root, 'CLAUDE.md').toString(),
    '# My Claude preferences\n\n@AGENTS.md\n',
  );
  assert.equal(apply(await prepare(root, ['testing'])), 0);
  apply(await prepare(root, []));
  assert.equal(read(root, 'CLAUDE.md').toString(), '# My Claude preferences');
});

test('identical skills can be adopted and restored; differing or extra files block adoption', async (t) => {
  const root = fixture(t);
  const catalog = loadCatalog(root);
  const state = await configure(catalog, {
    ...loadState(catalog),
    selected: ['graphiffy'],
  });
  const generated = render(catalog, state);
  for (const [file, content] of generated.files)
    if (file.startsWith('.agents/skills/')) put(root, file, content.content);
  const original = read(root, '.agents/skills/graphiffy/SKILL.md');
  apply(plan(catalog, state, generated, { adopt: true }));
  apply(await prepare(root, []));
  assert.deepEqual(read(root, '.agents/skills/graphiffy/SKILL.md'), original);
  assert.equal(
    fs.existsSync(path.join(root, '.claude/skills/graphiffy')),
    false,
  );
  put(root, '.agents/skills/graphiffy/extra.md', 'Keep me');
  const before = snapshot(root);
  await assert.rejects(prepare(root, ['graphiffy']), /Existing skill differs/);
  assert.deepEqual(snapshot(root), before);
  fs.unlinkSync(path.join(root, '.agents/skills/graphiffy/extra.md'));
  put(root, '.agents/skills/graphiffy/SKILL.md', 'User changes');
  await assert.rejects(prepare(root, ['graphiffy']), /Existing skill differs/);
});

test('tracked files, stale previews, edited outputs, and changed baselines block adoption writes', async (t) => {
  const root = fixture(t);
  put(root, 'AGENTS.md', 'Original');
  t.mock.method(childProcess, 'execFileSync', () => 'AGENTS.md\0');
  syncBuiltinESMExports();
  await assert.rejects(prepare(root, ['testing']), /Git-tracked/);
  t.mock.method(childProcess, 'execFileSync', () => '');
  syncBuiltinESMExports();
  const preview = await prepare(root, ['testing']);
  put(root, 'AGENTS.md', 'Changed during preview');
  assert.throws(() => apply(preview), /File changed since preview/);
  assert.equal(fs.existsSync(path.join(root, '.loadout/adopted')), false);
  apply(await prepare(root, ['testing']));
  const generated = read(root, 'AGENTS.md');
  put(root, 'AGENTS.md', 'Manual edits');
  await assert.rejects(prepare(root, []), /manually modified/);
  put(root, 'AGENTS.md', generated);
  const next = await prepare(root, []);
  const manifest = JSON.parse(read(root, '.loadout/adopted.json').toString());
  put(
    root,
    `.loadout/adopted/${manifest.files['AGENTS.md'].hash}`,
    'Corrupt baseline',
  );
  assert.throws(() => apply(next), /File changed since preview/);
  await assert.rejects(
    prepare(root, []),
    /Original content is missing or changed/,
  );
});

test('failed adoption across two locations restores outputs, baselines, metadata, and locks', async (t) => {
  const first = fixture(t);
  const second = fixture(t, true);
  put(first, 'AGENTS.md', 'Repository original');
  put(second, '.codex/AGENTS.md', 'Global original');
  const before = [snapshot(first), snapshot(second)];
  const plans = [
    await prepare(first, ['testing']),
    await prepare(second, ['testing'], true),
  ];
  const rename = fs.renameSync;
  let failed = false;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (!failed && String(to) === path.join(second, '.claude/CLAUDE.md')) {
      failed = true;
      throw new Error('Simulated write failure');
    }
    return rename(from, to);
  });
  assert.throws(() => applyAll(plans), /Simulated write failure/);
  assert.deepEqual([snapshot(first), snapshot(second)], before);
  for (const root of [first, second]) {
    assert.equal(fs.existsSync(path.join(root, '.loadout/adopted')), false);
    assert.equal(fs.existsSync(path.join(root, '.loadout/apply.lock')), false);
  }
});

test('adoption rechecks skill inventories and tracked status immediately before writing', async (t) => {
  const root = fixture(t);
  const catalog = loadCatalog(root);
  const state = await configure(catalog, {
    ...loadState(catalog),
    selected: ['graphiffy'],
  });
  const generated = render(catalog, state);
  for (const [file, content] of generated.files)
    if (file.startsWith('.agents/skills/')) put(root, file, content.content);
  const preview = plan(catalog, state, generated, { adopt: true });
  put(root, '.agents/skills/graphiffy/extra.md', 'New personal note');
  assert.throws(() => apply(preview), /Skill directory changed since preview/);
  assert.equal(fs.existsSync(path.join(root, '.loadout/adopted')), false);
  fs.unlinkSync(path.join(root, '.agents/skills/graphiffy/extra.md'));
  t.mock.method(
    childProcess,
    'execFileSync',
    () => '.agents/skills/graphiffy/SKILL.md\0',
  );
  syncBuiltinESMExports();
  assert.throws(() => apply(preview), /became Git-tracked/);
  assert.equal(fs.existsSync(path.join(root, '.loadout/adopted')), false);
});

test('shared original blobs survive partial release and originals with restricted modes are restored', (t) => {
  const root = fixture(t);
  const original = Buffer.from('Shared original');
  put(root, 'AGENTS.md', original);
  put(root, 'CLAUDE.md', original);
  if (process.platform !== 'win32')
    fs.chmodSync(path.join(root, 'AGENTS.md'), 0o600);
  const catalog = loadCatalog(root);
  const state = loadState(catalog);
  const generated = {
    files: new Map([
      ['AGENTS.md', { content: Buffer.from('Generated\n'), mode: 0o644 }],
      ['CLAUDE.md', { content: Buffer.from('@AGENTS.md\n'), mode: 0o644 }],
    ]),
    skillRoots: new Set<string>(),
  };
  apply(plan(catalog, state, generated, { adopt: true }));
  assert.equal(fs.readdirSync(path.join(root, '.loadout/adopted')).length, 1);
  generated.files.delete('AGENTS.md');
  apply(plan(catalog, state, generated));
  assert.deepEqual(read(root, 'AGENTS.md'), original);
  if (process.platform !== 'win32')
    assert.equal(fs.statSync(path.join(root, 'AGENTS.md')).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.join(root, '.loadout/adopted')).length, 1);
  generated.files.clear();
  apply(plan(catalog, state, generated));
  assert.deepEqual(read(root, 'CLAUDE.md'), original);
  assert.equal(fs.existsSync(path.join(root, '.loadout/adopted')), false);
});

test('downloads retry once automatically, then allow retry or cancellation', async () => {
  let attempts = 0,
    notices = 0,
    prompts = 0;
  assert.equal(
    await retryDownload(
      async () => {
        if (++attempts === 1) throw new Error('Temporary failure');
        return 'downloaded';
      },
      async () => {
        prompts++;
        return true;
      },
      () => {
        notices++;
      },
    ),
    'downloaded',
  );
  assert.deepEqual([attempts, notices, prompts], [2, 1, 0]);
  attempts = 0;
  assert.equal(
    await retryDownload(
      async () => {
        if (++attempts < 3) throw new Error('Network unavailable');
        return 'downloaded';
      },
      async () => {
        prompts++;
        return true;
      },
    ),
    'downloaded',
  );
  assert.deepEqual([attempts, prompts], [3, 1]);
  attempts = 0;
  await assert.rejects(
    retryDownload(
      async () => {
        attempts++;
        throw new Error('Offline');
      },
      async () => false,
    ),
    DownloadCancelledError,
  );
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(
    retryDownload(async () => {
      attempts++;
      throw new Error('Offline');
    }),
    /Offline/,
  );
  assert.equal(attempts, 2);
});

test('retry and adoption prompts offer cancellation', async () => {
  const retry = await prompt(
    (_config: object, context?: Parameters<typeof confirmRetry>[2]) =>
      confirmRetry('example', new Error('Network unavailable'), context),
    {},
  );
  assert.match(retry.getScreen(), /Retry download/);
  retry.events.keypress('down');
  retry.events.keypress('enter');
  assert.equal(await retry.answer, false);
  const adopt = await prompt(
    (_config: object, context?: Parameters<typeof confirmAdoption>[1]) =>
      confirmAdoption(['AGENTS.md'], context),
    {},
  );
  assert.match(adopt.getScreen(), /Originals will be restored/);
  adopt.events.type('n');
  adopt.events.keypress('enter');
  assert.equal(await adopt.answer, false);
});
