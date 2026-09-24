import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { prepareInstallations } from '../src/installations.js';
import { loadTarget } from '../src/targets.js';
import { configure } from '../src/resolve.js';
import { applyAll, loadGenerated, plan } from '../src/storage.js';
import { render } from '../src/render.js';
import { type State } from '../src/schema.js';
import { type ReviewTarget } from '../src/review.js';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-inheritance-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  t.mock.method(os, 'homedir', () => home);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(
    path.join(home, '.loadout/config.yaml'),
    stringify({ schemaVersion: 1, curated: false }),
  );
  const kit = path.join(home, '.loadout/kits/shared');
  write(
    path.join(kit, 'kit.yaml'),
    stringify({
      schemaVersion: 1,
      id: 'shared',
      description: 'Shared guidance',
      requires: ['base'],
      questions: {
        details: {
          type: 'boolean',
          message: 'Include details?',
          default: false,
        },
      },
      outputs: [
        { type: 'instructions', source: 'instructions.md' },
        {
          type: 'instructions',
          source: 'details.md',
          when: { answer: 'details', equals: true },
        },
        { type: 'skill', source: 'skills/example' },
      ],
    }),
  );
  write(path.join(kit, 'instructions.md'), 'Shared instructions.\n');
  write(path.join(kit, 'details.md'), 'Repository details.\n');
  write(
    path.join(kit, 'skills/example/SKILL.md'),
    '---\nname: example\ndescription: Example skill\n---\nSkill instructions.\n',
  );
  write(path.join(kit, 'skills/example/resource.txt'), 'Resource bytes.\n');
  write(
    path.join(home, '.loadout/kits/base/kit.yaml'),
    stringify({
      schemaVersion: 1,
      id: 'base',
      description: 'Base guidance',
      outputs: [{ type: 'instructions', source: 'instructions.md' }],
    }),
  );
  write(
    path.join(home, '.loadout/kits/base/instructions.md'),
    'Base instructions.\n',
  );
  const repo = (name: string, outside = false) => {
    const directory = path.join(outside ? root : home, name);
    fs.mkdirSync(directory);
    return directory;
  };
  const select = async (
    directory: string,
    selected: string[],
    answers?: State['answers'],
  ): Promise<ReviewTarget> => {
    const target = loadTarget(directory, directory === home);
    assert.ok(target.catalog, target.error ?? 'Cannot load catalog');
    return {
      target,
      state: await configure(target.catalog, {
        ...target.state!,
        selected,
        answers: answers ?? target.state!.answers,
      }),
      update: [],
    };
  };
  const prepare = async (selections: ReviewTarget[], adopt = false) =>
    prepareInstallations(selections, {
      adopt,
      render: () => ({ offline: true }),
    });
  const install = async (selection: ReviewTarget, adopt = false) => {
    const prepared = await prepare([selection], adopt);
    applyAll(prepared.map(({ plan }) => plan));
    return prepared;
  };
  const read = (directory: string, file: string) =>
    fs.readFileSync(path.join(directory, file), 'utf8');
  const exists = (directory: string, file: string) =>
    fs.existsSync(path.join(directory, file));
  return { home, repo, select, prepare, install, read, exists, write };
}

test('global promotion and removal reconcile every registered repository while retaining answers and dependencies', async (t) => {
  const f = fixture(t);
  const first = f.repo('first');
  const second = f.repo('second', true);
  await f.install(
    await f.select(first, ['shared'], { shared: { details: true } }),
  );
  await f.install(await f.select(second, ['shared']));
  const before = f.read(first, 'AGENTS.md');
  const times = loadGenerated(first).installedAt;

  const promotion = await f.prepare([await f.select(f.home, ['shared'])]);
  assert.deepEqual(
    new Set(promotion.map(({ target }) => target.root)),
    new Set([f.home, first, second]),
  );
  assert.equal(f.read(first, 'AGENTS.md'), before);
  applyAll(promotion.map(({ plan }) => plan));
  assert.equal(f.read(first, 'AGENTS.md'), 'Repository details.\n');
  assert.equal(f.exists(second, 'AGENTS.md'), false);
  for (const directory of [first, second]) {
    assert.equal(f.exists(directory, '.agents/skills/example/SKILL.md'), false);
    assert.equal(f.exists(directory, '.claude/skills/example/SKILL.md'), false);
    assert.deepEqual(loadTarget(directory, false).state!.selected, ['shared']);
    assert.deepEqual(loadGenerated(directory).inherited, ['base', 'shared']);
  }
  assert.deepEqual(loadGenerated(first).installedAt, times);
  assert.match(f.read(f.home, '.codex/AGENTS.md'), /Shared instructions/);
  assert.equal(
    f.read(f.home, '.agents/skills/example/resource.txt'),
    'Resource bytes.\n',
  );

  const late = f.repo('late');
  await f.install(await f.select(late, ['shared']));
  assert.equal(f.exists(late, 'AGENTS.md'), false);
  assert.equal(f.exists(late, '.claude/skills/example/SKILL.md'), false);
  await f.install(await f.select(f.home, []));
  for (const directory of [first, second, late]) {
    assert.match(f.read(directory, 'AGENTS.md'), /Shared instructions/);
    assert.equal(
      f.read(directory, '.agents/skills/example/resource.txt'),
      'Resource bytes.\n',
    );
    assert.match(
      f.read(directory, '.claude/skills/example/SKILL.md'),
      /Skill instructions/,
    );
    assert.deepEqual(loadGenerated(directory).inherited, []);
  }
  assert.equal(f.read(first, 'AGENTS.md'), before);
  assert.deepEqual(loadTarget(first, false).state!.answers.shared, {
    details: true,
  });
  assert.deepEqual(loadGenerated(first).installedAt, times);
});

test('simultaneous global and repository selections use the pending global plan and do not write during preview', async (t) => {
  const f = fixture(t);
  const repo = f.repo('project');
  const prepared = await f.prepare([
    await f.select(repo, ['shared']),
    await f.select(f.home, ['shared']),
  ]);
  assert.equal(f.exists(f.home, '.loadout-personal/repositories.json'), false);
  assert.equal(f.exists(repo, '.loadout-personal/local.json'), false);
  applyAll(prepared.map(({ plan }) => plan));
  assert.equal(f.exists(repo, 'AGENTS.md'), false);
  assert.equal(f.exists(repo, '.agents/skills/example/SKILL.md'), false);
  assert.deepEqual(loadTarget(repo, false).state!.selected, ['shared']);
});

test('unselecting an inherited kit in a repository prevents restoration there', async (t) => {
  const f = fixture(t);
  const repo = f.repo('project');
  await f.install(await f.select(f.home, ['shared']));
  await f.install(await f.select(repo, ['shared']));
  await f.install(await f.select(repo, []));
  await f.install(await f.select(f.home, []));
  assert.equal(f.exists(repo, 'AGENTS.md'), false);
  assert.equal(f.exists(repo, '.agents/skills/example/SKILL.md'), false);
  assert.deepEqual(loadTarget(repo, false).state!.selected, []);
});

test('global installation leaves unregistered repositories alone until they are applied', async (t) => {
  const f = fixture(t);
  const repo = f.repo('older-project');
  const selection = await f.select(repo, ['shared']);
  const catalog = selection.target.catalog!;
  applyAll([plan(catalog, selection.state, render(catalog, selection.state))]);
  assert.equal(f.exists(f.home, '.loadout-personal/repositories.json'), false);
  const before = f.read(repo, 'AGENTS.md');
  await f.install(await f.select(f.home, ['shared']));
  assert.equal(f.read(repo, 'AGENTS.md'), before);
  assert.deepEqual(
    JSON.parse(f.read(f.home, '.loadout-personal/repositories.json'))
      .repositories,
    [],
  );
  await f.install(await f.select(repo, ['shared']));
  assert.equal(f.exists(repo, 'AGENTS.md'), false);
  await f.install(await f.select(f.home, []));
  assert.match(f.read(repo, 'AGENTS.md'), /Shared instructions/);
});

test('first global installation never enumerates home', async (t) => {
  const f = fixture(t);
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof readdir>) => {
    assert.notEqual(String(args[0]), f.home, 'must not scan home');
    return readdir(...args);
  });
  const prepared = await f.install(await f.select(f.home, ['shared']));
  assert.deepEqual(
    prepared.map(({ target }) => target.root),
    [f.home],
  );
  assert.match(f.read(f.home, '.codex/AGENTS.md'), /Shared instructions/);
});

test('global installation registers and reconciles an explicitly known older repository', async (t) => {
  const f = fixture(t);
  const repo = f.repo('older-project');
  const selection = await f.select(repo, ['shared']);
  const catalog = selection.target.catalog!;
  applyAll([plan(catalog, selection.state, render(catalog, selection.state))]);
  const prepared = await prepareInstallations(
    [await f.select(f.home, ['shared'])],
    { knownRoots: [repo], render: () => ({ offline: true }) },
  );
  assert.deepEqual(
    prepared.map(({ target }) => target.root),
    [f.home, repo],
  );
  assert.equal(f.exists(f.home, '.loadout-personal/repositories.json'), false);
  applyAll(prepared.map(({ plan }) => plan));
  assert.equal(f.exists(repo, 'AGENTS.md'), false);
  assert.deepEqual(
    JSON.parse(f.read(f.home, '.loadout-personal/repositories.json'))
      .repositories,
    [repo],
  );
  await f.install(await f.select(f.home, []));
  assert.match(f.read(repo, 'AGENTS.md'), /Shared instructions/);
});

test('global instructions that were skipped do not suppress repository instructions', async (t) => {
  const f = fixture(t);
  const repo = f.repo('project');
  f.write(
    path.join(f.home, '.codex/AGENTS.md'),
    'Unmanaged global instructions.\n',
  );
  await f.install(await f.select(f.home, ['shared']));
  await f.install(await f.select(repo, ['shared']));
  assert.match(f.read(repo, 'AGENTS.md'), /Shared instructions/);
  assert.equal(f.exists(repo, '.agents/skills/example/SKILL.md'), false);
});

test('adopted repository instructions keep their originals and can be restored after global removal', async (t) => {
  const f = fixture(t);
  const repo = f.repo('project');
  f.write(path.join(repo, 'AGENTS.md'), 'Original instructions.\n');
  await f.install(await f.select(repo, ['shared']), true);
  const before = f.read(repo, 'AGENTS.md');
  await f.install(await f.select(f.home, ['shared']));
  assert.equal(f.read(repo, 'AGENTS.md'), 'Original instructions.\n');
  await f.install(await f.select(f.home, []));
  assert.equal(f.read(repo, 'AGENTS.md'), before);
});

test('a global change after a repository preview aborts before modifying the repository', async (t) => {
  const f = fixture(t);
  const repo = f.repo('project');
  await f.install(await f.select(f.home, ['shared']));
  const prepared = await f.prepare([await f.select(repo, ['shared'])]);
  await f.install(await f.select(f.home, []));
  assert.throws(
    () => applyAll(prepared.map(({ plan }) => plan)),
    /changed since preview/,
  );
  assert.equal(f.exists(repo, '.loadout-personal/local.json'), false);
});

test('failed global promotion rolls back global files, repository files, and registration together', async (t) => {
  const f = fixture(t);
  const repo = f.repo('project');
  await f.install(await f.select(repo, ['shared']));
  const before = f.read(repo, 'AGENTS.md');
  const registry = f.read(f.home, '.loadout-personal/repositories.json');
  const prepared = await f.prepare([await f.select(f.home, ['shared'])]);
  const rename = fs.renameSync;
  const failure = t.mock.method(
    fs,
    'renameSync',
    (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === path.join(repo, '.loadout-personal/generated.json'))
        throw new Error('Disk full');
      return rename(from, to);
    },
  );
  assert.throws(() => applyAll(prepared.map(({ plan }) => plan)), /Disk full/);
  failure.mock.restore();
  assert.equal(f.read(repo, 'AGENTS.md'), before);
  assert.equal(f.read(f.home, '.loadout-personal/repositories.json'), registry);
  assert.equal(f.exists(f.home, '.codex/AGENTS.md'), false);
  assert.match(
    f.read(repo, '.agents/skills/example/SKILL.md'),
    /Skill instructions/,
  );
});
