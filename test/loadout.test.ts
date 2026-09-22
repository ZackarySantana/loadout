import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stringify, parse as yaml } from 'yaml';
import { initialize } from './examples.js';
import { discover, loadCatalog } from '../src/catalog.js';
import {
  configure,
  resolveKits,
  reasons,
  disableKits,
} from '../src/resolve.js';
import { render } from '../src/render.js';
import { apply, plan, loadState } from '../src/storage.js';
import { type State } from '../src/schema.js';
import { ignoreTarget } from '../src/ignore.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function fixture(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initialize(root);
  return root;
}
function put(root: string, relative: string, text: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), text);
}
function read(root: string, relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}
function editKit(root: string, id: string, edit: (kit: any) => void): void {
  const file = `.loadout/kits/${id}/kit.yaml`;
  const kit = yaml(read(root, file));
  edit(kit);
  put(root, file, stringify(kit));
}
function run(root: string, args: string[], status = 0): string {
  const result = spawnSync(process.execPath, [cli, '-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, status, result.stdout + result.stderr);
  return result.stdout + result.stderr;
}
async function build(
  root: string,
  selected = ['graphiffy'],
  answers: State['answers'] = {},
) {
  const catalog = loadCatalog(root);
  const state = await configure(catalog, {
    ...loadState(catalog),
    selected,
    answers,
  });
  return plan(catalog, state, render(catalog, state));
}

test('acceptance: dependency, conditional content, complete skills, repeat apply, and disable', async (t) => {
  const root = fixture(t);
  const catalog = loadCatalog(root);
  assert.deepEqual(resolveKits(catalog, ['graphiffy']), [
    'code-navigation',
    'graphiffy',
  ]);
  assert.deepEqual(reasons(catalog, ['graphiffy'], 'code-navigation'), [
    'graphiffy',
  ]);
  apply(await build(root, ['graphiffy'], { graphiffy: { diagrams: true } }));
  assert.match(read(root, 'AGENTS.md'), /Code navigation/);
  assert.match(read(root, 'AGENTS.md'), /Mermaid/);
  assert.doesNotMatch(read(root, 'AGENTS.md'), /# Testing/);
  assert.equal(read(root, 'CLAUDE.md'), '@AGENTS.md\n');
  for (const agent of ['.agents', '.claude']) {
    assert.equal(
      read(root, `${agent}/skills/graphiffy/references/checklist.md`),
      read(
        root,
        '.loadout/kits/graphiffy/skills/graphiffy/references/checklist.md',
      ),
    );
  }
  const current = loadState(catalog);
  const configured = await configure(catalog, current);
  assert.equal(
    apply(plan(catalog, configured, render(catalog, configured))),
    0,
  );
  apply(await build(root, ['graphiffy'], { graphiffy: { diagrams: false } }));
  assert.doesNotMatch(read(root, 'AGENTS.md'), /Mermaid/);
  apply(await build(root, ['code-navigation']));
  assert.match(read(root, 'AGENTS.md'), /Code navigation/);
  assert.doesNotMatch(read(root, 'AGENTS.md'), /Graphiffy/);
  assert.equal(
    fs.existsSync(path.join(root, '.agents/skills/graphiffy')),
    false,
  );
  apply(await build(root, []));
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
});

test('CLI supports dry run, answers, explain, list, and cascading disable', (t) => {
  const root = fixture(t);
  assert.match(
    run(root, ['enable', 'graphiffy', '--dry-run']),
    /code-navigation required by graphiffy/,
  );
  assert.equal(
    fs.existsSync(path.join(root, '.loadout-personal/local.json')),
    false,
  );
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
  run(root, ['enable', 'graphiffy', '--answer', 'graphiffy.diagrams=true']);
  assert.match(read(root, 'AGENTS.md'), /Mermaid/);
  assert.equal(read(root, 'CLAUDE.md'), '@AGENTS.md\n');
  assert.match(
    run(root, ['explain', 'code-navigation']),
    /required by graphiffy/,
  );
  assert.match(run(root, ['list']), /testing \[disabled\]/);
  assert.match(run(root, ['apply']), /Generated files are unchanged/);
  assert.match(run(root, ['disable', 'code-navigation'], 1), /--cascade/);
  run(root, ['disable', 'code-navigation', '--cascade']);
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
  assert.match(run(root, [], 1), /needs a terminal/);
});

test('shared dependencies remain enabled and new catalog kits stay disabled', async (t) => {
  const root = fixture(t);
  editKit(root, 'testing', (p) => {
    p.requires = ['code-navigation'];
  });
  const catalog = loadCatalog(root);
  const selected = disableKits(
    catalog,
    ['graphiffy', 'testing'],
    'graphiffy',
    false,
  );
  assert.deepEqual(resolveKits(catalog, selected), [
    'code-navigation',
    'testing',
  ]);
  apply(await build(root, selected));
  put(
    root,
    '.loadout/kits/new-kit/kit.yaml',
    'schemaVersion: 1\nid: new-kit\ndescription: New optional kit\noutputs:\n  - type: instructions\n    source: instructions.md\n',
  );
  put(root, '.loadout/kits/new-kit/instructions.md', 'NEW OPTIONAL CONTENT');
  run(root, ['apply']);
  assert.doesNotMatch(read(root, 'AGENTS.md'), /NEW OPTIONAL/);
  assert.match(run(root, ['list']), /new-kit \[disabled\]/);
});

test('cycles, missing dependencies, missing sources, and duplicate IDs fail before generation', (t) => {
  for (const [edit, expected] of [
    [
      (root: string) =>
        editKit(root, 'code-navigation', (p) => {
          p.requires = ['graphiffy'];
        }),
      /Dependency cycle/,
    ],
    [
      (root: string) =>
        editKit(root, 'graphiffy', (p) => {
          p.requires = ['missing'];
        }),
      /Unknown kit: missing/,
    ],
    [
      (root: string) =>
        fs.unlinkSync(path.join(root, '.loadout/kits/graphiffy/diagrams.md')),
      /missing source/,
    ],
    [
      (root: string) =>
        editKit(root, 'testing', (p) => {
          p.id = 'graphiffy';
        }),
      /Duplicate kit ID/,
    ],
  ] as const) {
    const root = fixture(t);
    edit(root);
    assert.throws(() => loadCatalog(root), expected);
    assert.equal(
      fs.existsSync(path.join(root, '.loadout-personal/local.json')),
      false,
    );
  }
});

test('colliding skill outputs are rejected', async (t) => {
  const root = fixture(t);
  editKit(root, 'graphiffy', (p) => {
    p.outputs.push({ type: 'skill', source: 'skills/graphiffy' });
  });
  await assert.rejects(build(root), /Output collision/);
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
});

test('unmanaged files and skill directories are preserved', async (t) => {
  const root = fixture(t);
  put(root, 'CLAUDE.md', 'Human instructions');
  const preview = await build(root);
  assert.match(
    preview.skippedInstructions![0]!.reason,
    /CLAUDE.md already exists/,
  );
  apply(preview);
  assert.equal(read(root, 'CLAUDE.md'), 'Human instructions');
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
  apply(await build(root, []));
  fs.unlinkSync(path.join(root, 'CLAUDE.md'));
  put(root, '.agents/skills/graphiffy/personal.txt', 'Human skill');
  await assert.rejects(build(root), /Unmanaged skill directory/);
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
});

test('manually edited generated files block updates and deletion without partial writes', async (t) => {
  const root = fixture(t);
  apply(await build(root));
  const stateBefore = read(root, '.loadout-personal/local.json');
  put(root, 'CLAUDE.md', 'Personal edits');
  await assert.rejects(
    build(root, ['testing']),
    /manually modified: CLAUDE.md/,
  );
  assert.match(read(root, 'AGENTS.md'), /Graphiffy/);
  assert.equal(read(root, '.loadout-personal/local.json'), stateBefore);
  await assert.rejects(build(root, []), /manually modified/);
});

test('tracked instructions are skipped while mixed kits install skills and report empty dependency kits', async (t) => {
  for (const existing of [
    ['AGENTS.md'],
    ['CLAUDE.md'],
    ['AGENTS.md', 'CLAUDE.md'],
  ]) {
    const root = fixture(t);
    execFileSync('git', ['init', '-q', root]);
    for (const file of existing) put(root, file, `Team ${file}\n`);
    execFileSync('git', ['-C', root, 'add', ...existing]);
    const catalog = loadCatalog(root);
    const state = await configure(catalog, {
      ...loadState(catalog),
      selected: ['graphiffy'],
    });
    // Interactive setup uses adopt, but tracked instructions must still skip.
    const preview = plan(catalog, state, render(catalog, state), {
      adopt: true,
    });
    assert.deepEqual(preview.adopted, []);
    assert.deepEqual(preview.kitsWithoutOutputs, ['code-navigation']);
    assert.equal(
      preview.changes.some((change) =>
        ['AGENTS.md', 'CLAUDE.md'].includes(change.path),
      ),
      false,
    );
    const dryRun = run(root, [
      'enable',
      'graphiffy',
      '--adopt',
      '--dry-run',
      '--diff',
    ]);
    assert.match(
      dryRun,
      /Skipped instructions from code-navigation, graphiffy/,
    );
    assert.match(dryRun, /tracked by Git/);
    assert.match(dryRun, /code-navigation: no agent outputs will be applied/);
    assert.equal(
      fs.existsSync(path.join(root, '.loadout-personal/local.json')),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(root, '.agents/skills/graphiffy')),
      false,
    );
    const output = run(root, ['enable', 'graphiffy', '--adopt']);
    assert.match(
      output.slice(output.indexOf('Loadout applied')),
      /Skipped instructions/,
    );
    assert.match(output, /code-navigation: no agent outputs applied/);
    for (const agent of ['.agents', '.claude'])
      assert.ok(
        fs.existsSync(path.join(root, agent, 'skills/graphiffy/SKILL.md')),
      );
    const owned = JSON.parse(
      read(root, '.loadout-personal/generated.json'),
    ).files;
    assert.equal(owned['AGENTS.md'], undefined);
    assert.equal(owned['CLAUDE.md'], undefined);
    assert.doesNotMatch(
      read(root, '.git/info/exclude'),
      /^\/(?:AGENTS|CLAUDE)\.md$/m,
    );
    assert.match(run(root, ['apply']), /Skipped instructions/);
    run(root, ['disable', 'graphiffy']);
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      if (existing.includes(file))
        assert.equal(read(root, file), `Team ${file}\n`);
      else assert.equal(fs.existsSync(path.join(root, file)), false);
    }
  }
});

for (const cliKit of ['claude-cli', 'codex-cli', 'opencode-cli']) {
  test(`${cliKit} kit requires placement and can switch between context and skill`, (t) => {
    const root = fixture(t);
    const id = `loadout-${cliKit}`;
    const instructions = fs.readFileSync(
      `kits/loadout-agent-clis/${cliKit}/instructions.md`,
      'utf8',
    );
    const skill = fs.readFileSync(
      `kits/loadout-agent-clis/${cliKit}/skills/${id}/SKILL.md`,
      'utf8',
    );
    assert.match(
      run(root, ['enable', id], 1),
      new RegExp(`${id}\\.placement: missing required answer`),
    );
    for (const file of [
      'AGENTS.md',
      'CLAUDE.md',
      '.loadout-personal/local.json',
    ])
      assert.equal(fs.existsSync(path.join(root, file)), false);
    run(root, ['enable', id, '--answer', `${id}.placement=context`]);
    assert.equal(read(root, 'AGENTS.md'), instructions);
    assert.equal(read(root, 'CLAUDE.md'), '@AGENTS.md\n');
    for (const agent of ['.agents', '.claude'])
      assert.equal(fs.existsSync(path.join(root, agent, 'skills', id)), false);

    run(root, ['enable', id, '--answer', `${id}.placement=skill`]);
    for (const file of ['AGENTS.md', 'CLAUDE.md'])
      assert.equal(fs.existsSync(path.join(root, file)), false);
    for (const agent of ['.agents', '.claude'])
      assert.equal(read(root, `${agent}/skills/${id}/SKILL.md`), skill);
    assert.match(run(root, ['apply']), /Generated files are unchanged/);

    run(root, ['enable', id, '--answer', `${id}.placement=context`]);
    assert.equal(read(root, 'AGENTS.md'), instructions);
    assert.equal(read(root, 'CLAUDE.md'), '@AGENTS.md\n');
    for (const agent of ['.agents', '.claude'])
      assert.equal(fs.existsSync(path.join(root, agent, 'skills', id)), false);
  });

  test(`${cliKit} skill installs after context is skipped for existing project instructions`, (t) => {
    for (const { existing, tracked } of [
      { existing: ['AGENTS.md'], tracked: true },
      { existing: ['CLAUDE.md'], tracked: true },
      { existing: ['AGENTS.md', 'CLAUDE.md'], tracked: true },
      { existing: ['AGENTS.md', 'CLAUDE.md'], tracked: false },
    ]) {
      const root = fixture(t);
      const id = `loadout-${cliKit}`;
      execFileSync('git', ['init', '-q', root]);
      for (const file of existing) put(root, file, `Team ${file}\n`);
      if (tracked) execFileSync('git', ['-C', root, 'add', ...existing]);
      assert.match(
        run(root, ['enable', id, '--answer', `${id}.placement=context`]),
        new RegExp(`${id}: no agent outputs applied; all instructions skipped`),
      );
      const output = run(root, [
        'enable',
        id,
        '--answer',
        `${id}.placement=skill`,
        '--adopt',
      ]);
      assert.doesNotMatch(output, /Skipped instructions|no agent outputs/);
      for (const agent of ['.agents', '.claude'])
        assert.equal(
          read(root, `${agent}/skills/${id}/SKILL.md`),
          fs.readFileSync(
            `kits/loadout-agent-clis/${cliKit}/skills/${id}/SKILL.md`,
            'utf8',
          ),
        );
      const owned = JSON.parse(
        read(root, '.loadout-personal/generated.json'),
      ).files;
      for (const file of ['AGENTS.md', 'CLAUDE.md']) {
        assert.equal(owned[file], undefined);
        if (existing.includes(file))
          assert.equal(read(root, file), `Team ${file}\n`);
        else assert.equal(fs.existsSync(path.join(root, file)), false);
      }
      assert.match(run(root, ['apply']), /Generated files are unchanged/);
      run(root, ['disable', id]);
      for (const file of existing)
        assert.equal(read(root, file), `Team ${file}\n`);
      for (const agent of ['.agents', '.claude'])
        assert.equal(
          fs.existsSync(path.join(root, agent, 'skills', id)),
          false,
        );
    }
  });
}

test('instruction-only kits report no outputs and unaffected scopes still apply', (t) => {
  const root = fixture(t);
  put(root, 'AGENTS.md', 'Team guidance');
  const output = run(root, ['enable', 'testing']);
  assert.match(
    output,
    /testing: no agent outputs applied; all instructions skipped/,
  );
  assert.equal(read(root, 'AGENTS.md'), 'Team guidance');
  assert.equal(fs.existsSync(path.join(root, 'CLAUDE.md')), false);
  assert.deepEqual(
    JSON.parse(read(root, '.loadout-personal/generated.json')).files,
    {},
  );
  fs.mkdirSync(path.join(root, 'src'));
  editKit(root, 'testing', (kit) => {
    kit.outputs.push({
      type: 'instructions',
      source: 'instructions.md',
      scope: 'src',
    });
  });
  const scoped = run(root, ['apply']);
  assert.match(scoped, /Skipped instructions from testing/);
  assert.doesNotMatch(scoped, /no agent outputs/);
  assert.match(read(root, 'src/AGENTS.md'), /Testing/);
  assert.equal(read(root, 'src/CLAUDE.md'), '@AGENTS.md\n');
  run(root, ['disable', 'testing']);
  assert.equal(read(root, 'AGENTS.md'), 'Team guidance');
  assert.equal(fs.existsSync(path.join(root, 'src/AGENTS.md')), false);
});

test('Git tracks catalog but ignores exact generated paths and local state', (t) => {
  const root = fixture(t);
  execFileSync('git', ['init', '-q', root]);
  run(root, ['enable', 'graphiffy']);
  put(root, '.claude/settings.json', '{}');
  execFileSync('git', ['-C', root, 'add', '.']);
  const tracked = execFileSync('git', ['-C', root, 'ls-files'], {
    encoding: 'utf8',
  });
  assert.match(tracked, /\.loadout\/kits\/graphiffy\/kit.yaml/);
  assert.match(tracked, /\.claude\/settings.json/);
  assert.doesNotMatch(
    tracked,
    /local.json|generated.json|^AGENTS.md|^CLAUDE.md|^\.agents\/skills/m,
  );
  const ignored = execFileSync(
    'git',
    [
      '-C',
      root,
      'check-ignore',
      'AGENTS.md',
      '.claude/skills/graphiffy/SKILL.md',
    ],
    { encoding: 'utf8' },
  );
  assert.match(ignored, /AGENTS.md/);
  execFileSync('git', ['-C', root, 'add', '-f', 'AGENTS.md']);
  assert.match(run(root, ['apply'], 1), /Git-tracked file/);
});

test('discovery stops at .git file boundaries and state is independent', (t) => {
  const root = fixture(t);
  execFileSync('git', ['init', '-q', root]);
  const worktree = path.join(root, 'other-worktree');
  fs.mkdirSync(worktree);
  // Separate Git metadata gives us the same .git-file discovery boundary as a
  // worktree, without creating commits in the test setup.
  execFileSync('git', [
    'init',
    '-q',
    '--separate-git-dir',
    path.join(root, 'other-git'),
    worktree,
  ]);
  initialize(worktree);
  run(root, ['enable', 'graphiffy']);
  assert.deepEqual(loadState(loadCatalog(worktree)).selected, []);
  fs.mkdirSync(path.join(worktree, 'nested'));
  assert.equal(discover(path.join(worktree, 'nested')), worktree);
  fs.unlinkSync(path.join(worktree, '.loadout/config.yaml'));
  assert.equal(discover(worktree), worktree);
});

test('directory scopes remain native and scoped skills are rejected', async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'packages/ui'), { recursive: true });
  editKit(root, 'testing', (p) => {
    p.outputs[0].scope = 'packages/ui';
  });
  apply(await build(root, ['testing']));
  assert.match(read(root, 'packages/ui/AGENTS.md'), /Testing/);
  assert.equal(read(root, 'packages/ui/CLAUDE.md'), '@AGENTS.md\n');
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
  editKit(root, 'graphiffy', (p) => {
    p.outputs[2].scope = 'packages/ui';
  });
  assert.throws(() => loadCatalog(root), /Unrecognized key/);
});

test('path traversal and source/output symlinks are rejected', async (t) => {
  const root = fixture(t);
  editKit(root, 'testing', (p) => {
    p.outputs[0].source = '../graphiffy/instructions.md';
  });
  assert.throws(() => loadCatalog(root), /relative path/);
  editKit(root, 'testing', (p) => {
    p.outputs[0].source = 'instructions.md';
  });
  fs.unlinkSync(path.join(root, '.loadout/kits/testing/instructions.md'));
  fs.symlinkSync(
    path.join(root, '.loadout/kits/graphiffy/instructions.md'),
    path.join(root, '.loadout/kits/testing/instructions.md'),
  );
  assert.throws(() => loadCatalog(root), /Symlinks/);
  fs.unlinkSync(path.join(root, '.loadout/kits/testing/instructions.md'));
  put(root, '.loadout/kits/testing/instructions.md', '# Testing');
  fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'AGENTS.md'));
  await assert.rejects(build(root), /Symlinks/);
});

test('choice questions, required input, and changed questions are validated', async (t) => {
  const root = fixture(t);
  editKit(root, 'graphiffy', (p) => {
    p.questions.style = {
      type: 'choice',
      message: 'Which style?',
      choices: ['brief', 'detailed'],
    };
    p.outputs[1].when = { answer: 'style', equals: 'detailed' };
  });
  await assert.rejects(build(root), /missing required answer/);
  run(root, ['enable', 'graphiffy', '--answer', 'graphiffy.style=detailed']);
  assert.match(read(root, 'AGENTS.md'), /Mermaid/);
  run(root, ['apply', '--answer', 'graphiffy.style=brief']);
  assert.doesNotMatch(read(root, 'AGENTS.md'), /Mermaid/);
  editKit(root, 'graphiffy', (p) => {
    p.questions.style.choices = ['detailed'];
  });
  assert.match(run(root, ['apply'], 1), /invalid saved answer/);
  assert.match(
    run(root, ['apply', '--answer', 'graphiffy.diagrams=maybe'], 1),
    /Invalid answer/,
  );
});

test('deleted kits can be deselected to recover saved state', (t) => {
  const root = fixture(t);
  run(root, ['enable', 'testing']);
  fs.rmSync(path.join(root, '.loadout/kits/testing'), { recursive: true });
  assert.match(run(root, ['apply'], 1), /Unknown kit: testing/);
  run(root, ['disable', 'testing']);
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
});

test('stale previews and concurrent applies are rejected', async (t) => {
  const root = fixture(t);
  const preview = await build(root);
  put(root, 'AGENTS.md', 'Added after preview');
  assert.throws(() => apply(preview), /File changed since preview/);
  assert.equal(fs.existsSync(path.join(root, 'CLAUDE.md')), false);
  fs.unlinkSync(path.join(root, 'AGENTS.md'));
  fs.mkdirSync(path.join(root, '.loadout-personal/apply.lock'));
  assert.throws(() => apply(preview), /Another apply/);
});

test('I/O failures roll back already written files', async (t) => {
  const root = fixture(t);
  const preview = await build(root);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (to.toString() === path.join(root, 'CLAUDE.md'))
      throw new Error('Simulated write failure');
    rename(from, to);
  });
  assert.throws(() => apply(preview), /Simulated write failure/);
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
  assert.equal(
    fs.existsSync(path.join(root, '.agents/skills/graphiffy/SKILL.md')),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(root, '.loadout-personal/local.json')),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(root, '.loadout-personal/apply.lock')),
    false,
  );
});

test('skill binary files and executable permissions survive generation', async (t) => {
  const root = fixture(t);
  const source = '.loadout/kits/graphiffy/skills/graphiffy';
  put(root, `${source}/asset.bin`, Buffer.from([0, 255, 128, 10]));
  put(root, `${source}/scripts/tool.sh`, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(root, `${source}/scripts/tool.sh`), 0o755);
  apply(await build(root));
  assert.deepEqual(
    fs.readFileSync(path.join(root, '.agents/skills/graphiffy/asset.bin')),
    Buffer.from([0, 255, 128, 10]),
  );
  if (process.platform !== 'win32')
    assert.equal(
      fs.statSync(path.join(root, '.agents/skills/graphiffy/scripts/tool.sh'))
        .mode & 0o777,
      0o755,
    );
});

test('malformed ownership and ignore blocks fail before any writes', async (t) => {
  const root = fixture(t);
  put(
    root,
    '.loadout-personal/generated.json',
    JSON.stringify({
      schemaVersion: 1,
      installedAt: {},
      files: { '../outside': { hash: 'a'.repeat(64), mode: 420 } },
    }),
  );
  await assert.rejects(build(root), /Invalid generated ownership path/);
  fs.unlinkSync(path.join(root, '.loadout-personal/generated.json'));
  execFileSync('git', ['init', '-q', root]);
  put(root, '.git/info/exclude', `# >>> loadout ${ignoreTarget(root)!.key}\n`);
  await assert.rejects(build(root), /Malformed Loadout block/);
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
});

test('CLI content previews show instruction changes without saving them', (t) => {
  const root = fixture(t);
  run(root, ['enable', 'testing']);
  put(
    root,
    '.loadout/kits/testing/instructions.md',
    '# Testing\n\nNew testing guidance.\n',
  );
  const preview = run(root, ['apply', '--dry-run', '--diff']);
  assert.match(preview, /\+New testing guidance/);
  assert.doesNotMatch(read(root, 'AGENTS.md'), /New testing guidance/);
  assert.doesNotMatch(preview, /"answers"/);
});

test('CLI initializes without a terminal and hides ignore files from previews', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-init-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  assert.match(run(root, ['init']), /Initialized .*\.loadout/);
  const preview = run(root, [
    'enable',
    'loadout-write-kit',
    '--dry-run',
    '--diff',
  ]);
  assert.match(preview, /skills\/loadout-write-kit\/SKILL.md/);
  assert.doesNotMatch(preview, /\.gitignore|info[\/]exclude/);
  assert.equal(
    fs.existsSync(path.join(root, '.loadout-personal/local.json')),
    false,
  );
  run(root, ['enable', 'loadout-write-kit']);
  assert.match(read(root, '.git/info/exclude'), /loadout-write-kit\/SKILL\.md/);
  assert.equal(fs.existsSync(path.join(root, '.gitignore')), false);
});
