import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { initialize } from '../src/init.js';
import { installExamples } from './examples.js';
import { loadCatalog } from '../src/catalog.js';
import { render } from '../src/render.js';
import { apply, applyAll, loadState, plan } from '../src/storage.js';
import { ignoreTarget } from '../src/ignore.js';

function temporary(t: TestContext): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-ignore-')),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}
function setup(root: string): void {
  initialize(root);
  installExamples(root);
}
function preview(root: string, selected = ['testing']) {
  const catalog = loadCatalog(root);
  const state = { ...loadState(catalog), selected };
  return plan(catalog, state, render(catalog, state));
}
function excluded(root: string, file: string): boolean {
  const result = spawnSync('git', [
    '-C',
    root,
    'check-ignore',
    '-q',
    '--',
    file,
  ]);
  assert.ok(
    result.status === 0 || result.status === 1,
    result.stderr.toString(),
  );
  return result.status === 0;
}
function excludes(root: string): string {
  return path.join(ignoreTarget(root)!.root, 'info/exclude');
}

test('init and selection changes preserve tracked gitignore and unrelated local exclusions', (t) => {
  const root = temporary(t);
  git(root, 'init', '-q');
  const shared = '# Team rules\r\nnode_modules/\r\n';
  fs.writeFileSync(path.join(root, '.gitignore'), shared);
  git(root, 'add', '.gitignore');
  const ignore = excludes(root);
  fs.writeFileSync(ignore, '# My local rules\r\n/scratch/\r\n');
  setup(root);
  const initial = fs.readFileSync(ignore, 'utf8');
  const proposed = preview(root, ['graphiffy']);
  assert.equal(fs.readFileSync(ignore, 'utf8'), initial);
  assert.equal(excluded(root, 'AGENTS.md'), false);
  apply(proposed);
  assert.ok(
    fs
      .readFileSync(ignore, 'utf8')
      .startsWith('# My local rules\r\n/scratch/\r\n'),
  );
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), shared);
  assert.equal(git(root, 'diff', '--', '.gitignore'), '');
  for (const file of [
    'AGENTS.md',
    'CLAUDE.md',
    '.loadout-personal/local.json',
    '.loadout-personal/kits/private/kit.yaml',
    '.agents/skills/graphiffy/SKILL.md',
  ])
    assert.equal(excluded(root, file), true, file);
  assert.equal(excluded(root, '.loadout/config.yaml'), false);
  assert.equal(excluded(root, '.loadout/kits/testing/kit.yaml'), false);
  assert.equal(excluded(root, '.claude/settings.json'), false);
  assert.equal(apply(preview(root, ['graphiffy'])), 0);
  apply(preview(root, []));
  assert.equal(excluded(root, 'AGENTS.md'), false);
  assert.equal(excluded(root, '.agents/skills/graphiffy/SKILL.md'), false);
  assert.equal(excluded(root, 'scratch/notes'), true);
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), shared);
});

test('plain directories and global catalogs do not create ignore files', (t) => {
  for (const global of [false, true]) {
    const root = temporary(t);
    initialize(root, global);
    const catalog = loadCatalog(root, global);
    const state = { ...loadState(catalog), selected: ['loadout-write-kit'] };
    const proposed = plan(catalog, state, render(catalog, state));
    assert.equal(proposed.exclude, undefined);
    apply(proposed);
    assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);
  }
});

test("linked worktrees retain each other's exclusions in single and combined applies", (t) => {
  const base = temporary(t);
  const main = path.join(base, 'main'),
    other = path.join(base, 'other');
  fs.mkdirSync(main);
  git(main, 'init', '-q');
  // The commit belongs only to this disposable fixture, to create a worktree.
  git(
    main,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  );
  git(main, 'worktree', 'add', '-q', '-b', 'other', other);
  setup(main);
  setup(other);
  assert.equal(excludes(main), excludes(other));
  applyAll([preview(main, ['graphiffy']), preview(other, ['testing'])]);
  apply(preview(other, []));
  assert.equal(excluded(main, 'AGENTS.md'), true);
  assert.equal(excluded(main, '.agents/skills/graphiffy/SKILL.md'), true);
  assert.equal(apply(preview(main, ['graphiffy'])), 0);
  apply(preview(main, []));
  assert.equal(excluded(main, 'AGENTS.md'), false);
  assert.equal(excluded(main, '.agents/skills/graphiffy/SKILL.md'), false);
  assert.equal(fs.existsSync(path.join(main, '.gitignore')), false);
  assert.equal(fs.existsSync(path.join(other, '.gitignore')), false);
});

test('nested catalog exclusions are anchored and escape directory metacharacters', (t) => {
  const root = temporary(t);
  git(root, 'init', '-q');
  const nested = path.join(root, 'project [one]');
  fs.mkdirSync(nested);
  setup(nested);
  apply(preview(nested));
  assert.equal(excluded(root, 'project [one]/AGENTS.md'), true);
  assert.equal(
    excluded(root, 'project [one]/.loadout-personal/local.json'),
    true,
  );
  assert.equal(excluded(root, 'project o/AGENTS.md'), false);
  assert.equal(excluded(root, 'AGENTS.md'), false);
});

test('stale excludes and shared exclude locks prevent any output writes', (t) => {
  const root = temporary(t);
  git(root, 'init', '-q');
  setup(root);
  const proposed = preview(root);
  const ignore = excludes(root);
  fs.appendFileSync(ignore, '/new-personal-rule\n');
  assert.throws(
    () => apply(proposed),
    /File changed since preview: info\/exclude/,
  );
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
  assert.match(fs.readFileSync(ignore, 'utf8'), /new-personal-rule/);
  const lock = `${ignore}.loadout.lock`;
  fs.mkdirSync(lock);
  assert.throws(
    () => apply(preview(root)),
    /Another apply is using Git excludes/,
  );
  assert.equal(fs.existsSync(lock), true);
  assert.equal(
    fs.existsSync(path.join(root, '.loadout-personal/apply.lock')),
    false,
  );
});

test('failed output writes roll back local excludes and release all locks', (t) => {
  const root = temporary(t);
  git(root, 'init', '-q');
  setup(root);
  const ignore = excludes(root);
  const original = fs.readFileSync(ignore);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (to.toString() === path.join(root, '.loadout-personal/generated.json'))
      throw new Error('Simulated state write failure');
    rename(from, to);
  });
  assert.throws(() => apply(preview(root)), /Simulated state write failure/);
  assert.deepEqual(fs.readFileSync(ignore), original);
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
  assert.equal(
    fs.existsSync(path.join(root, '.loadout-personal/local.json')),
    false,
  );
  assert.equal(fs.existsSync(`${ignore}.loadout.lock`), false);
  assert.equal(
    fs.existsSync(path.join(root, '.loadout-personal/apply.lock')),
    false,
  );
});

test('malformed local excludes prevent initialization without changing shared ignores', (t) => {
  const root = temporary(t);
  git(root, 'init', '-q');
  const ignore = excludes(root);
  const malformed = `# >>> loadout ${ignoreTarget(root)!.key}\n`;
  fs.writeFileSync(ignore, malformed);
  assert.throws(() => initialize(root), /Malformed Loadout block/);
  assert.equal(fs.existsSync(path.join(root, '.loadout')), false);
  assert.equal(fs.readFileSync(ignore, 'utf8'), malformed);
  assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);
});

test('releasing adopted instructions removes their personal exclusions', (t) => {
  const root = temporary(t);
  git(root, 'init', '-q');
  setup(root);
  fs.writeFileSync(
    path.join(root, 'AGENTS.md'),
    'Existing personal guidance\n',
  );
  const catalog = loadCatalog(root);
  const state = { ...loadState(catalog), selected: ['testing'] };
  apply(plan(catalog, state, render(catalog, state), { adopt: true }));
  assert.equal(excluded(root, 'AGENTS.md'), true);
  apply(preview(root, []));
  assert.equal(excluded(root, 'AGENTS.md'), false);
  assert.equal(
    fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
    'Existing personal guidance\n',
  );
});
