import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render as prompt } from '@inquirer/testing';
import stringWidth from 'string-width';
import { continuePicker } from './picker-helpers.js';
import { targetPicker } from '../src/picker.js';
import { initialize } from './examples.js';
import { loadTarget, type Target } from '../src/targets.js';
import { loadCatalog, discover } from '../src/catalog.js';
import { configure } from '../src/resolve.js';
import { render } from '../src/render.js';
import { apply, applyAll, loadState, plan } from '../src/storage.js';

function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-global-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'project');
  fs.mkdirSync(repo);
  initialize(repo);
  return { home, repo };
}
async function preview(target: Target, selected: string[]) {
  const catalog = target.catalog!;
  const state = await configure(catalog, { ...loadState(catalog), selected });
  return plan(catalog, state, render(catalog, state));
}

test('scope switching works without global initialization and retains independent selections', async (t) => {
  const { home, repo } = fixture(t);
  const repository = loadTarget(repo, false);
  apply(await preview(repository, ['testing']));
  const screen = await prompt(targetPicker, {
    targets: [loadTarget(repo, false), loadTarget(home, true)],
    columns: 80,
    rows: 24,
  });
  const switchScope = () => screen.input.write('\u001b[D\r');
  assert.match(screen.getScreen(), /Repository/);
  switchScope();
  assert.match(screen.getScreen(), /Global/);
  assert.match(screen.getScreen(), /\[Browse\]/);
  assert.doesNotMatch(screen.getScreen(), /Set up Global/);
  assert.equal(fs.existsSync(path.join(home, '.loadout')), false);
  screen.events.keypress('space');
  screen.events.type('write-kit');
  screen.events.keypress('space');
  switchScope();
  assert.match(screen.getScreen(), /Unapplied changes in Global/);
  screen.events.keypress('y');
  assert.match(screen.getScreen(), /1 selected/);
  continuePicker(screen);
  const selections = await screen.answer;
  assert.deepEqual(
    selections.map(({ target, state }) => [target.global, state.selected]),
    [
      [false, ['testing']],
      [true, ['loadout-write-kit']],
    ],
  );
  assert.deepEqual(loadState(repository.catalog!).selected, ['testing']);
  assert.equal(
    fs.existsSync(path.join(home, '.loadout-personal/local.json')),
    false,
  );
});

test('initialized locations display their own selections, errors preserve the active location, and narrow layout fits', async (t) => {
  const { home, repo } = fixture(t);
  initialize(home);
  const global = loadTarget(home, true);
  apply(await preview(global, ['testing']));
  const screen = await prompt(targetPicker, {
    targets: [loadTarget(repo, false), loadTarget(home, true)],
    columns: 40,
    rows: 16,
  });
  screen.input.write('\u001b[Z');
  assert.match(screen.getScreen(), /Switch to Global/);
  assert.match(screen.getScreen(), /space\/enter switch/);
  assert.doesNotMatch(screen.getScreen(), /selected|Search/);
  for (const line of screen.getScreen().split('\n'))
    assert.ok(stringWidth(line) <= 40, line);
  assert.ok(screen.getScreen().split('\n').length <= 16);
  screen.events.keypress('space');
  assert.match(screen.getScreen(), /Global/);
  assert.match(screen.getScreen(), /1 selected/);
  for (const line of screen.getScreen().split('\n'))
    assert.ok(stringWidth(line) <= 40, line);
  assert.ok(screen.getScreen().split('\n').length <= 16);
  screen.input.write('\u001b[Z');
  assert.match(screen.getScreen(), /Switch to Repository/);
  assert.doesNotMatch(screen.getScreen(), /Kits for this repository/);
  screen.events.keypress('escape');
  assert.match(screen.getScreen(), /1 selected/);
  continuePicker(screen);
  assert.deepEqual((await screen.answer)[0]!.state.selected, ['testing']);

  const failed = await prompt(targetPicker, {
    targets: [
      loadTarget(repo, false),
      { ...global, catalog: undefined, error: 'Invalid home configuration' },
    ],
  });
  failed.input.write('\u001b[Z ');
  assert.match(failed.getScreen(), /Invalid home configuration/);
  assert.match(failed.getScreen(), /Repository ·/);
  continuePicker(failed);
  await failed.answer;
});

test('global generation uses personal paths, supports both targets in one apply, and preserves unmanaged files', async (t) => {
  const { home, repo } = fixture(t);
  initialize(home);
  const global = loadTarget(home, true),
    repository = loadTarget(repo, false);
  applyAll([
    await preview(repository, ['testing']),
    await preview(global, ['graphiffy']),
  ]);
  const read = (root: string, p: string) =>
    fs.readFileSync(path.join(root, p), 'utf8');
  assert.match(read(home, '.codex/AGENTS.md'), /Code navigation/);
  assert.equal(read(home, '.claude/CLAUDE.md'), '@../.codex/AGENTS.md\n');
  assert.equal(fs.existsSync(path.join(home, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(home, 'CLAUDE.md')), false);
  assert.equal(
    fs.existsSync(path.join(home, '.agents/skills/graphiffy/SKILL.md')),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(home, '.claude/skills/graphiffy/SKILL.md')),
    true,
  );
  assert.match(read(repo, 'AGENTS.md'), /# Testing/);
  assert.equal(apply(await preview(global, ['graphiffy'])), 0);
  apply(await preview(global, []));
  assert.equal(fs.existsSync(path.join(home, '.codex/AGENTS.md')), false);
  assert.match(read(repo, 'AGENTS.md'), /# Testing/);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/CLAUDE.md'),
    'My existing preferences',
  );
  const skipped = await preview(global, ['testing']);
  assert.deepEqual(skipped.kitsWithoutOutputs, ['testing']);
  apply(skipped);
  assert.equal(fs.existsSync(path.join(home, '.codex/AGENTS.md')), false);
  assert.equal(read(home, '.claude/CLAUDE.md'), 'My existing preferences');
});

test('multiple-location apply rolls back both roots and releases every lock on failure', async (t) => {
  const { home, repo } = fixture(t);
  initialize(home);
  const plans = [
    await preview(loadTarget(repo, false), ['testing']),
    await preview(loadTarget(home, true), ['testing']),
  ];
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (to.toString() === path.join(home, '.codex/AGENTS.md'))
      throw new Error('Simulated global write failure');
    rename(from, to);
  });
  assert.throws(() => applyAll(plans), /Simulated global write failure/);
  for (const root of [home, repo]) {
    assert.equal(
      fs.existsSync(path.join(root, '.loadout-personal/apply.lock')),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(root, '.loadout-personal/local.json')),
      false,
    );
  }
  assert.equal(fs.existsSync(path.join(repo, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(home, '.claude/CLAUDE.md')), false);
});

test('a stale global preview prevents repository writes, and an existing global lock is preserved', async (t) => {
  const { home, repo } = fixture(t);
  initialize(home);
  const plans = [
    await preview(loadTarget(repo, false), ['testing']),
    await preview(loadTarget(home, true), ['testing']),
  ];
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(
    path.join(home, '.codex/AGENTS.md'),
    'Changed since preview',
  );
  assert.throws(() => applyAll(plans), /File changed since preview/);
  assert.equal(fs.existsSync(path.join(repo, 'AGENTS.md')), false);
  fs.mkdirSync(path.join(home, '.loadout-personal/apply.lock'));
  assert.throws(() => applyAll(plans), /Another apply/);
  assert.equal(
    fs.existsSync(path.join(home, '.loadout-personal/apply.lock')),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(repo, '.loadout-personal/apply.lock')),
    false,
  );
});

test('home catalogs are not discovered for uninitialized child projects and global scopes are validated', (t) => {
  const { home, repo } = fixture(t);
  initialize(home);
  t.mock.method(os, 'homedir', () => home);
  assert.equal(discover(repo), repo);
  const empty = path.join(home, 'uninitialized');
  fs.mkdirSync(empty);
  assert.equal(discover(empty), empty);
  assert.equal(discover(home), home);
  assert.equal(loadCatalog(home).global, true);
  const file = path.join(home, '.loadout/kits/testing/kit.yaml');
  fs.writeFileSync(
    file,
    fs.readFileSync(file, 'utf8') + '    scope: project\n',
  );
  const catalog = loadCatalog(home);
  assert.throws(
    () => render(catalog, { ...loadState(catalog), selected: ['testing'] }),
    /global instructions must use scope/,
  );
});

test('scope warning detects removals, ignores reverted edits, and preserves the filter on cancellation', async (t) => {
  const { home, repo } = fixture(t);
  initialize(home, true);
  apply(await preview(loadTarget(repo, false), ['testing']));
  const ui = await prompt(targetPicker, {
    targets: [loadTarget(repo, false), loadTarget(home, true)],
    columns: 40,
    rows: 16,
  });
  ui.events.keypress('space');
  ui.events.keypress('space'); // Revert the selection change.
  ui.input.write('\u001b[D\r');
  assert.match(ui.getScreen(), /\[Browse\]/);
  assert.doesNotMatch(ui.getScreen(), /Unapplied changes/);
  ui.input.write('\u001b[D\r');
  ui.events.type('testing');
  ui.events.keypress('space'); // Removing an installed selection also needs a warning.
  ui.input.write('\u001b[D\r');
  assert.match(ui.getScreen(), /Unapplied changes in Repository/);
  for (const line of ui.getScreen().split('\n'))
    assert.ok(stringWidth(line) <= 40, line);
  assert.ok(ui.getScreen().split('\n').length <= 16);
  ui.events.keypress('escape');
  assert.match(ui.getScreen(), /\/ testing/);
  assert.match(ui.getScreen(), /0 selected/);
  assert.deepEqual(loadState(loadTarget(repo, false).catalog!).selected, [
    'testing',
  ]);
  continuePicker(ui);
  assert.deepEqual((await ui.answer)[0]!.state.selected, []);
});
