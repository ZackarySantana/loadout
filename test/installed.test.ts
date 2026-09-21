import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { render as prompt } from '@inquirer/testing';
import stringWidth from 'string-width';
import { loadTarget, type Target } from '../src/targets.js';
import { configure } from '../src/resolve.js';
import { render } from '../src/render.js';
import {
  apply,
  applyAll,
  hasChanges,
  loadGenerated,
  plan,
} from '../src/storage.js';
import { targetPicker } from '../src/picker.js';
import { type Kit } from '../src/schema.js';

function fixture(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-installed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.loadout'));
  fs.writeFileSync(
    path.join(root, '.loadout/config.yaml'),
    stringify({ schemaVersion: 1, curated: false }),
  );
  for (const id of ['alpha', 'base', 'beta']) {
    const directory = path.join(root, '.loadout/kits', id);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'kit.yaml'),
      stringify({
        schemaVersion: 1,
        id,
        description: `${id} guidance`,
        requires: id === 'alpha' ? ['base'] : [],
        outputs: [{ type: 'instructions', source: 'instructions.md' }],
      }),
    );
    fs.writeFileSync(
      path.join(directory, 'instructions.md'),
      `# ${id}\nGuidance.\n`,
    );
  }
  return root;
}
async function preview(root: string, selected: string[], global = false) {
  const target = loadTarget(root, global);
  assert.ok(target.catalog, target.error ?? 'Catalog did not load');
  const state = await configure(target.catalog, { ...target.state!, selected });
  return plan(target.catalog, state, render(target.catalog, state));
}

test('installation times are saved on apply, include dependencies, survive updates, and reset on reinstall', async (t) => {
  const root = fixture(t);
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-09-20T10:00:00Z'),
  });
  const first = await preview(root, ['alpha']);
  assert.equal(
    fs.existsSync(path.join(root, '.loadout-personal/generated.json')),
    false,
  );
  t.mock.timers.setTime(Date.parse('2026-09-20T11:00:00Z'));
  apply(first);
  const firstTime = new Date().toISOString();
  assert.deepEqual(loadGenerated(root).installedAt, {
    alpha: firstTime,
    base: firstTime,
  });
  assert.deepEqual(
    loadTarget(root, false).installedAt,
    loadGenerated(root).installedAt,
  );
  assert.equal(loadGenerated(root).schemaVersion, 1);

  t.mock.timers.setTime(Date.parse('2026-09-21T12:00:00Z'));
  const unchanged = await preview(root, ['alpha']);
  assert.equal(hasChanges(unchanged), false);
  assert.equal(apply(unchanged), 0);
  fs.appendFileSync(
    path.join(root, '.loadout/kits/alpha/instructions.md'),
    'Updated guidance.\n',
  );
  apply(await preview(root, ['alpha', 'beta']));
  const betaTime = new Date().toISOString();
  assert.deepEqual(loadGenerated(root).installedAt, {
    alpha: firstTime,
    base: firstTime,
    beta: betaTime,
  });

  apply(await preview(root, ['beta']));
  assert.deepEqual(loadGenerated(root).installedAt, { beta: betaTime });
  t.mock.timers.setTime(Date.parse('2026-09-22T13:00:00Z'));
  apply(await preview(root, ['alpha', 'beta']));
  const reinstalled = new Date().toISOString();
  assert.deepEqual(loadGenerated(root).installedAt, {
    alpha: reinstalled,
    base: reinstalled,
    beta: betaTime,
  });
});

test('repository and user installation times are independent and roll back with failed applies', async (t) => {
  const repo = fixture(t);
  const home = fixture(t);
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-09-20T10:00:00Z'),
  });
  apply(await preview(repo, ['alpha']));
  t.mock.timers.setTime(Date.parse('2026-09-21T10:00:00Z'));
  apply(await preview(home, ['alpha'], true));
  assert.notEqual(
    loadGenerated(repo).installedAt.alpha,
    loadGenerated(home).installedAt.alpha,
  );
  const before = [repo, home].map((root) =>
    fs.readFileSync(path.join(root, '.loadout-personal/generated.json')),
  );
  const plans = [
    await preview(repo, ['alpha', 'beta']),
    await preview(home, ['alpha', 'beta'], true),
  ];
  const rename = fs.renameSync;
  const mocked = t.mock.method(
    fs,
    'renameSync',
    (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === path.join(home, '.loadout-personal/generated.json'))
        throw new Error('Disk full');
      return rename(from, to);
    },
  );
  assert.throws(() => applyAll(plans), /Disk full/);
  mocked.mock.restore();
  for (const [index, root] of [repo, home].entries()) {
    assert.deepEqual(
      fs.readFileSync(path.join(root, '.loadout-personal/generated.json')),
      before[index],
    );
    assert.deepEqual(loadTarget(root, root === home).state!.selected, [
      'alpha',
    ]);
    assert.equal(loadGenerated(root).installedAt.beta, undefined);
  }
});

test('generated metadata requires installation times without migration', (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, '.loadout-personal'));
  const file = path.join(root, '.loadout-personal/generated.json');
  for (const data of [
    { schemaVersion: 1, files: {} },
    { schemaVersion: 1, installedAt: { alpha: 'yesterday' }, files: {} },
  ]) {
    const content = JSON.stringify(data);
    fs.writeFileSync(file, content);
    assert.throws(() => loadGenerated(root), /generated.json/);
    assert.match(loadTarget(root, false).error!, /generated.json/);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
});

test('Installed shows local installation times newest first in each scope and fits narrow terminals', async () => {
  const kits: Kit[] = ['alpha', 'beta'].map((id) => ({
    schemaVersion: 1,
    id,
    description: `${id} guidance`,
    directory: '.',
    requires: [],
    outputs: [],
    questions: {},
  }));
  const oldest = new Date(2026, 8, 19, 9, 15).toISOString();
  const newest = new Date(2026, 8, 20, 14, 30).toISOString();
  const repository: Target = {
    label: 'Repository',
    root: '/project',
    global: false,
    catalog: {
      root: '/project',
      kits: new Map(kits.map((kit) => [kit.id, kit])),
    },
    state: { schemaVersion: 1, selected: ['alpha', 'beta'], answers: {} },
    installedAt: { alpha: oldest, beta: newest },
  };
  const global: Target = {
    ...repository,
    label: 'Global',
    root: '/home/user',
    global: true,
    installedAt: { alpha: newest, beta: oldest },
  };
  for (const columns of [40, 80]) {
    const ui = await prompt(targetPicker, {
      targets: [repository, global],
      columns,
      rows: 20,
    });
    ui.events.keypress('left');
    assert.match(ui.getScreen(), /\[Installed\]/);
    assert.match(ui.getScreen(), /› ● beta/);
    assert.match(ui.getScreen(), /Installed 2026-09-20 14:30/);
    assert.match(ui.getScreen(), /beta guidance/);
    const height = ui.getScreen().split('\n').length;
    ui.events.keypress('space');
    assert.match(ui.getScreen(), /beta[^\n]*Will uninstall/);
    assert.match(ui.getScreen(), /Installed 2026-09-20 14:30/);
    assert.equal(ui.getScreen().split('\n').length, height);
    ui.events.keypress('down');
    assert.match(ui.getScreen(), /› ● alpha/);
    assert.match(ui.getScreen(), /Installed 2026-09-19 09:15/);
    ui.events.keypress('tab');
    ui.events.keypress('right');
    assert.match(ui.getScreen(), /\[Installed\]/);
    assert.match(ui.getScreen(), /› ● alpha/);
    assert.match(ui.getScreen(), /Installed 2026-09-20 14:30/);
    for (const line of ui.getScreen().split('\n'))
      assert.ok(stringWidth(line) <= columns, line);
    assert.ok(ui.getScreen().split('\n').length <= 20);
    const rejected = assert.rejects(ui.answer, { name: 'ExitPromptError' });
    ui.input.write('\u0003');
    await rejected;
  }
});

test('cached downloads and pending selections stay out of Installed in both scopes', async () => {
  const source = {
    repo: 'acme/skills',
    ref: '2'.repeat(40),
    skills: ['skills/cached'],
    license: 'LICENSE',
  };
  const cached: Kit = {
    schemaVersion: 1,
    id: 'cached',
    description: 'Cached kit',
    directory: '.',
    requires: [],
    outputs: [],
    questions: {},
    external: source,
    pinned: { ...source, ref: '1'.repeat(40) },
  };
  for (const global of [false, true]) {
    const target: Target = {
      label: global ? 'Global' : 'Repository',
      root: '.',
      global,
      catalog: { root: '.', kits: new Map([[cached.id, cached]]) },
      state: { schemaVersion: 1, selected: [], answers: {} },
      installedAt: {},
    };
    const ui = await prompt(targetPicker, { targets: [target] });
    ui.events.keypress('right');
    assert.match(ui.getScreen(), /No kits installed/);
    assert.doesNotMatch(ui.getScreen(), /cached|Downloaded only|updates/);
    ui.events.keypress('left');
    ui.events.keypress('enter');
    ui.events.keypress('space');
    assert.match(ui.getScreen(), /● cached/);
    ui.events.keypress('right');
    assert.match(ui.getScreen(), /No kits installed/);
    assert.doesNotMatch(
      ui.getScreen(),
      /● cached|Downloaded only|Not installed yet/,
    );
    const rejected = assert.rejects(ui.answer, { name: 'ExitPromptError' });
    ui.input.write('\u0003');
    await rejected;
  }
});
