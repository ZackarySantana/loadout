import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-package-'));
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run through npm run test:package');
const runNpm = (args, cwd) =>
  execFileSync(process.execPath, [npm, ...args], { cwd, encoding: 'utf8' });
try {
  const [packed] = JSON.parse(
    runNpm(['pack', '--json', '--pack-destination', root], process.cwd()),
  );
  const files = packed.files.map((file) => file.path);
  assert.ok(files.includes('LICENSE'));
  assert.ok(files.includes('dist/cli.js'));
  assert.ok(files.includes('kits/write-kit/skills/loadout-write-kit/SKILL.md'));
  assert.ok(
    files.every(
      (file) => !/^(src|test|scripts|\.loadout|\.github)\//.test(file),
    ),
  );
  // Install the actual tarball and its production dependencies, isolated from
  // this checkout and its dev dependencies. Also verify the global bin shim.
  const prefix = path.join(root, 'installed');
  runNpm(
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      path.join(root, packed.filename),
    ],
    root,
  );
  const moduleRoot =
    process.platform === 'win32' ? prefix : path.join(prefix, 'lib');
  const cli = path.join(moduleRoot, 'node_modules/@lidtop/loadout/dist/cli.js');
  const bin =
    process.platform === 'win32'
      ? path.join(prefix, 'loadout.cmd')
      : path.join(prefix, 'bin/loadout');
  assert.ok(fs.existsSync(bin));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const run = (...args) =>
    execFileSync(process.execPath, [cli, '-C', project, ...args], {
      encoding: 'utf8',
      cwd: project,
      env: { ...process.env, HOME: root, USERPROFILE: root },
    });
  assert.equal(run('--version').trim(), packed.version);
  assert.match(run('list'), /loadout-write-kit/);
  assert.equal(fs.existsSync(path.join(project, '.loadout')), false);
  run('--offline', 'enable', 'loadout-write-kit');
  assert.equal(fs.existsSync(path.join(project, '.loadout')), false);
  assert.ok(fs.existsSync(path.join(project, '.loadout-personal/local.json')));
  for (const agent of ['.agents', '.claude'])
    assert.ok(
      fs.existsSync(
        path.join(project, agent, 'skills/loadout-write-kit/SKILL.md'),
      ),
    );
  assert.equal(fs.existsSync(path.join(project, 'CLAUDE.md')), false);
  assert.match(run('--offline', 'apply'), /unchanged/);
  run('--offline', 'disable', 'loadout-write-kit');
  for (const agent of ['.agents', '.claude'])
    assert.equal(
      fs.existsSync(
        path.join(project, agent, 'skills/loadout-write-kit/SKILL.md'),
      ),
      false,
    );
  assert.match(run('init'), /editable starter kit/);
  assert.match(run('list'), /starter \[Needs setup\]/);
  console.log(
    'Packed install, CLI, bundled assets, repeat apply, and removal passed.',
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
