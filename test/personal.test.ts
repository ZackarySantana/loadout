import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadCatalog, discover } from '../src/catalog.js';
import { loadState } from '../src/storage.js';
import { loadTarget } from '../src/targets.js';
import { render } from '@inquirer/testing';
import { targetPicker } from '../src/picker.js';
import { continuePicker } from './picker-helpers.js';

function fixture(t: TestContext) {
  const home = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-personal-')),
  );
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => home);
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const run = (args: string[], root = repo, status = 0) => {
    const result = spawnSync(
      process.execPath,
      [path.resolve('dist/cli.js'), '-C', root, '--offline', ...args],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home },
      },
    );
    assert.equal(result.status, status, result.stdout + result.stderr);
    return result.stdout + result.stderr;
  };
  return { home, repo, run };
}
function kit(
  root: string,
  directory: string,
  id: string,
  instructions = id,
  requires: string[] = [],
) {
  const target = path.join(root, directory, 'kits', id);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(target, 'kit.yaml'),
    `schemaVersion: 1\nid: ${id}\ndescription: ${id} guidance\nrequires: ${JSON.stringify(requires)}\noutputs:\n  - type: instructions\n    source: instructions.md\n`,
  );
  fs.writeFileSync(path.join(target, 'instructions.md'), instructions);
}

test('solo CLI works without init, keeps previews read-only, and leaves Git clean', (t) => {
  const { repo, run } = fixture(t);
  fs.mkdirSync(path.join(repo, 'src'));
  assert.equal(discover(path.join(repo, 'src')), repo);
  assert.match(run(['list']), /loadout-write-kit/);
  assert.match(run(['enable', 'loadout-write-kit', '--dry-run']), /Dry run/);
  assert.equal(fs.existsSync(path.join(repo, '.loadout-personal')), false);
  assert.equal(fs.existsSync(path.join(repo, '.loadout')), false);
  run(['enable', 'loadout-write-kit'], path.join(repo, 'src'));
  assert.equal(
    fs.existsSync(path.join(repo, '.agents/skills/loadout-write-kit/SKILL.md')),
    true,
  );
  assert.deepEqual(loadState(loadCatalog(repo)).selected, [
    'loadout-write-kit',
  ]);
  assert.equal(fs.existsSync(path.join(repo, '.loadout')), false);
  assert.equal(fs.existsSync(path.join(repo, '.gitignore')), false);
  assert.equal(
    execFileSync('git', ['-C', repo, 'status', '--porcelain'], {
      encoding: 'utf8',
    }),
    '',
  );
  assert.match(run(['apply']), /unchanged/);
  run(['disable', 'loadout-write-kit']);
  assert.equal(
    fs.existsSync(path.join(repo, '.agents/skills/loadout-write-kit')),
    false,
  );
});

test('personal and shared catalogs compose without losing solo selections', (t) => {
  const { repo, run } = fixture(t);
  kit(
    repo,
    '.loadout-personal',
    'personal-review',
    'Personal review instructions',
  );
  run(['enable', 'personal-review']);
  const originalState = fs.readFileSync(
    path.join(repo, '.loadout-personal/local.json'),
    'utf8',
  );
  run(['init']);
  assert.equal(
    fs.readFileSync(path.join(repo, '.loadout-personal/local.json'), 'utf8'),
    originalState,
  );
  kit(repo, '.loadout', 'team-checks', 'Team checks');
  kit(
    repo,
    '.loadout-personal',
    'personal-review',
    'Personal review instructions',
    ['team-checks'],
  );
  run(['apply']);
  const text = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
  assert.match(text, /Personal review instructions/);
  assert.match(text, /Team checks/);
  assert.deepEqual(loadState(loadCatalog(repo)).selected, ['personal-review']);
  execFileSync('git', ['-C', repo, 'add', '.']);
  const tracked = execFileSync('git', ['-C', repo, 'ls-files'], {
    encoding: 'utf8',
  });
  assert.match(tracked, /\.loadout\/kits\/team-checks/);
  assert.doesNotMatch(tracked, /loadout-personal|AGENTS.md|CLAUDE.md/);
  run(['disable', 'personal-review']);
  assert.equal(fs.existsSync(path.join(repo, 'AGENTS.md')), false);
});

test('home catalog availability is independent from per-repository and global selections', (t) => {
  const { home, repo, run } = fixture(t);
  kit(home, '.loadout', 'home-review', 'Home review instructions');
  const second = path.join(home, 'second');
  fs.mkdirSync(second);
  execFileSync('git', ['init', '-q', second]);
  assert.match(run(['list']), /home-review \[disabled\]/);
  run(['enable', 'home-review']);
  assert.deepEqual(loadState(loadCatalog(second)).selected, []);
  assert.equal(fs.existsSync(path.join(home, '.codex/AGENTS.md')), false);
  run(['--global', 'enable', 'home-review']);
  assert.match(
    fs.readFileSync(path.join(home, '.codex/AGENTS.md'), 'utf8'),
    /Home review/,
  );
  run(['disable', 'home-review']);
  assert.equal(fs.existsSync(path.join(repo, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(home, '.codex/AGENTS.md')), true);
  assert.deepEqual(loadState(loadCatalog(second)).selected, []);
});

test('personal catalog conflicts are explicit and private config can disable curated kits', (t) => {
  const { repo, run } = fixture(t);
  kit(repo, '.loadout-personal', 'review');
  fs.writeFileSync(
    path.join(repo, '.loadout-personal/config.yaml'),
    'schemaVersion: 1\ncurated: false\n',
  );
  assert.deepEqual([...loadCatalog(repo).kits.keys()], ['review']);
  kit(repo, '.loadout', 'review');
  assert.match(run(['list'], repo, 1), /Duplicate kit ID: review/);
  assert.equal(
    fs.existsSync(path.join(repo, '.loadout-personal/local.json')),
    false,
  );
});

test('personal kits appear under Browse without a shared catalog', async (t) => {
  const { repo } = fixture(t);
  kit(repo, '.loadout-personal', 'private-review');
  const ui = await render(targetPicker, { targets: [loadTarget(repo, false)] });
  assert.match(ui.getScreen(), /\[Browse\]/);
  ui.events.type('Personal');
  ui.events.keypress('space');
  assert.match(ui.getScreen(), /private-review/);
  ui.events.keypress('space');
  continuePicker(ui);
  assert.deepEqual((await ui.answer)[0]!.state.selected, ['private-review']);
  assert.equal(
    fs.existsSync(path.join(repo, '.loadout-personal/local.json')),
    false,
  );
});

test('scoped home kits only validate their destination when selected', (t) => {
  const { home, repo, run } = fixture(t);
  kit(home, '.loadout', 'frontend');
  fs.appendFileSync(
    path.join(home, '.loadout/kits/frontend/kit.yaml'),
    '    scope: frontend\n',
  );
  assert.match(run(['list']), /frontend \[disabled\]/);
  run(['enable', 'loadout-write-kit']);
  assert.match(
    run(['enable', 'frontend'], repo, 1),
    /scope directory does not exist/,
  );
  fs.mkdirSync(path.join(repo, 'frontend'));
  run(['enable', 'frontend']);
  assert.equal(
    fs.readFileSync(path.join(repo, 'frontend/AGENTS.md'), 'utf8'),
    'frontend\n',
  );
  assert.match(run(['--global', 'list']), /frontend \[disabled\]/);
  assert.match(
    run(['--global', 'enable', 'frontend'], repo, 1),
    /global instructions must use scope/,
  );
});
