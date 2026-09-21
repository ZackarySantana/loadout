import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { render } from '@inquirer/testing';
import stringWidth from 'string-width';
import { continuePicker } from './picker-helpers.js';
import { initialize } from '../src/init.js';
import { loadTarget } from '../src/targets.js';
import { targetPicker } from '../src/picker.js';
import { kitSource } from '../src/schema.js';

const cli = path.resolve('dist/cli.js');

test('global CLI init starts empty and the bundled authoring kit installs offline', (t) => {
  for (const explicitGlobal of [true, false]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-bundled-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const entry = path.join(home, 'cli.mjs');
    fs.writeFileSync(
      entry,
      `import os from 'node:os';\nos.homedir = () => ${JSON.stringify(home)};\nawait import(${JSON.stringify(pathToFileURL(cli).href)});\n`,
    );
    const run = (...args: string[]) =>
      execFileSync(
        process.execPath,
        [entry, ...(explicitGlobal ? ['--global'] : ['-C', home]), ...args],
        { encoding: 'utf8' },
      );
    const output = run('init');
    assert.match(output, /Choose kits from Browse/);
    assert.doesNotMatch(output, /with code-navigation/);
    assert.deepEqual(fs.readdirSync(path.join(home, '.loadout')), [
      'config.yaml',
    ]);
    assert.equal(fs.existsSync(path.join(home, '.agents')), false);
    assert.deepEqual(loadTarget(home, true).state?.selected, []);
    assert.deepEqual(
      [...loadTarget(home, true).catalog!.kits.values()]
        .filter((kit) => kit.origin === 'bundled')
        .map((kit) => [kit.id, kitSource(kit)]),
      [
        ['loadout-claude-cli', 'loadout-agent-clis'],
        ['loadout-codex-cli', 'loadout-agent-clis'],
        ['loadout-greenfield', 'loadout'],
        ['loadout-opencode-cli', 'loadout-agent-clis'],
        ['loadout-write-kit', 'loadout'],
      ],
    );
    run('--offline', 'enable', 'loadout-write-kit');
    const source = fs.readFileSync(
      'kits/write-kit/skills/loadout-write-kit/SKILL.md',
      'utf8',
    );
    for (const agent of ['.agents', '.claude']) {
      assert.equal(
        fs.readFileSync(
          path.join(home, agent, 'skills/loadout-write-kit/SKILL.md'),
          'utf8',
        ),
        source,
      );
    }
    assert.equal(fs.existsSync(path.join(home, '.codex/AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(home, '.claude/CLAUDE.md')), false);
    assert.equal(fs.existsSync(path.join(home, '.loadout/kits')), false);
    assert.match(run('--offline', 'apply'), /unchanged/);
    assert.deepEqual(loadTarget(home, true).state?.selected, [
      'loadout-write-kit',
    ]);
  }
});

test('Loadout leads Browse and selected bundled kits appear in Installed', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-browse-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  initialize(home, true);
  for (const [columns, rows] of [
    [80, 24],
    [40, 16],
  ]) {
    const ui = await render(targetPicker, {
      targets: [loadTarget(home, true)],
      columns,
      rows,
    });
    assert.doesNotMatch(ui.getScreen(), /○ loadout-/);
    assert.match(ui.getScreen(), /\[Browse\]/);
    assert.doesNotMatch(ui.getScreen(), /\bKits\b/);
    ui.events.keypress('left');
    assert.match(ui.getScreen(), /\[Installed\]/);
    ui.events.keypress('right');
    assert.match(ui.getScreen(), /› ▸ loadout/);
    assert.match(ui.getScreen(), /\[ Review changes \]/);
    assert.ok(ui.getScreen().split('\n').length <= rows!);
    assert.doesNotMatch(ui.getScreen(), /ctrl\+c|esc×2/);
    ui.events.keypress('space');
    assert.doesNotMatch(ui.getScreen(), /claude-cli|codex-cli|opencode-cli/);
    ui.events.type('write-kit');
    ui.events.keypress('space');
    ui.events.keypress('right');
    assert.match(ui.getScreen(), /\[Installed\]/);
    assert.match(ui.getScreen(), /● loadout-write-kit/);
    assert.doesNotMatch(ui.getScreen(), /ctrl\+c|esc×2/);
    for (const line of ui.getScreen().split('\n'))
      assert.ok(stringWidth(line) <= columns!, line);
    assert.ok(ui.getScreen().split('\n').length <= rows!);
    continuePicker(ui);
    assert.deepEqual((await ui.answer)[0]!.state.selected, [
      'loadout-write-kit',
    ]);
  }
});

test('agent CLI kits browse and install under their own provider with stable IDs', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-agent-clis-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  initialize(home, true);
  const ui = await render(targetPicker, {
    targets: [loadTarget(home, true)],
    columns: 80,
    rows: 32,
  });
  ui.events.type('loadout-agent-clis');
  assert.match(ui.getScreen(), /› ▸ loadout-agent-clis\s+3 kits/);
  assert.match(
    ui.getScreen(),
    /Delegate tasks through agent CLI harnesses/,
  );
  ui.events.keypress('space');
  for (const name of ['claude-cli', 'codex-cli', 'opencode-cli'])
    assert.match(ui.getScreen(), new RegExp(`○ ${name}`));
  assert.doesNotMatch(ui.getScreen(), /greenfield|write-kit|○ loadout-/);
  ui.events.keypress('space');
  ui.events.keypress('down');
  ui.events.keypress('space');
  ui.events.keypress('down');
  ui.events.keypress('space');
  ui.events.keypress('right');
  assert.match(ui.getScreen(), /\[Installed\]/);
  for (const name of ['claude-cli', 'codex-cli', 'opencode-cli'])
    assert.match(ui.getScreen(), new RegExp(`● loadout-${name}`));
  assert.match(ui.getScreen(), /loadout-agent-clis · Run non-interactive/);
  continuePicker(ui);
  assert.deepEqual((await ui.answer)[0]!.state.selected, [
    'loadout-claude-cli',
    'loadout-codex-cli',
    'loadout-opencode-cli',
  ]);
});
