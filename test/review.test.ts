import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '@inquirer/testing';
import stringWidth from 'string-width';
import {
  reviewRows,
  reviewScreen,
  selectionSummary,
  type ReviewTarget,
} from '../src/review.js';
import { type Kit, type State } from '../src/schema.js';

const kit = (id: string, requires: string[] = []): Kit => ({
  schemaVersion: 1,
  id,
  directory: '.',
  description: `${id} workflow`,
  requires,
  outputs: [],
  questions: {},
});
const state = (selected: string[]): State => ({
  schemaVersion: 1,
  selected,
  answers: {},
});
function selection(kits: Kit[], saved: State, next: State): ReviewTarget {
  return {
    target: {
      label: 'Repository',
      root: '/project',
      global: false,
      catalog: {
        root: '/project',
        kits: new Map(kits.map((kit) => [kit.id, kit])),
      },
      state: saved,
    },
    state: next,
    update: [],
  };
}
type UI = Awaited<ReturnType<typeof render>>;
function focus(ui: UI, text: string): void {
  for (
    let i = 0;
    i < 100 &&
    !ui
      .getScreen()
      .split('\n')
      .some((line) => line.includes('›') && line.includes(text));
    i++
  )
    ui.events.keypress('down');
  assert.ok(
    ui
      .getScreen()
      .split('\n')
      .some((line) => line.includes('›') && line.includes(text)),
    ui.getScreen(),
  );
}

test('effective kit changes distinguish required dependencies, direct selection, and removal', () => {
  const kits = [kit('app', ['base']), kit('base'), kit('legacy'), kit('extra')];
  const item = selection(
    kits,
    state(['app', 'base', 'legacy']),
    state(['app', 'extra']),
  );
  const summary = selectionSummary(item);
  assert.deepEqual(
    summary.map(({ id, effect, unchanged }) => [id, effect, unchanged]),
    [
      ['app', 'Keep', true],
      ['base', 'Keep', false],
      ['extra', 'Add', false],
      ['legacy', 'Remove', false],
    ],
  );
  assert.ok(
    summary
      .find(({ id }) => id === 'base')!
      .notes.includes('still required of app'),
  );
  const addition = selectionSummary(selection(kits, state([]), state(['app'])));
  assert.deepEqual(
    addition.map(({ id, effect }) => [id, effect]),
    [
      ['app', 'Add'],
      ['base', 'Add'],
    ],
  );
  assert.ok(addition[1]!.notes.includes('dependency of app'));
  const direct = selectionSummary(
    selection(kits, state(['app']), state(['app', 'base'])),
  );
  assert.ok(direct[1]!.notes.includes('chosen directly'));
});

test('summary separates configuration and revision updates from selected kit additions', () => {
  const source = {
    repo: 'acme/skills',
    ref: '2'.repeat(40),
    skills: ['skills/example'],
    license: 'LICENSE',
  };
  const configured = {
    ...kit('configured'),
    questions: {
      placement: {
        type: 'choice' as const,
        message: 'Install where?',
        choices: ['context', 'skill'],
      },
    },
  };
  const external = {
    ...kit('external'),
    external: source,
    pinned: { ...source, ref: '1'.repeat(40) },
  };
  const saved = {
    ...state(['configured', 'external']),
    answers: { configured: { placement: 'context' } },
  };
  const next = { ...saved, answers: { configured: { placement: 'skill' } } };
  const item = {
    ...selection([configured, external], saved, next),
    update: ['external'],
  };
  const summary = selectionSummary(item);
  assert.equal(summary[0]!.effect, 'Configure');
  assert.ok(summary[0]!.notes.includes('Install as: skill'));
  assert.equal(summary[1]!.effect, 'Update');
  assert.ok(summary[1]!.notes.includes('1111111 → 2222222'));
});

test('final review keeps kit rows separate from file totals and exposes skipped and adopted effects', () => {
  const item = selection([kit('alpha')], state([]), state(['alpha']));
  item.plan = {
    root: '/project',
    changes: [
      { path: 'AGENTS.md', kind: 'update' },
      { path: '.agents/skills/alpha/SKILL.md', kind: 'create' },
      { path: '.loadout-personal/local.json', kind: 'update' },
    ],
    adopted: ['AGENTS.md'],
    skippedInstructions: [
      {
        kits: ['alpha'],
        paths: ['CLAUDE.md'],
        reason: 'existing instructions',
      },
    ],
    kitsWithoutOutputs: ['alpha'],
  };
  const text = reviewRows([item], [])
    .map(({ text }) => text)
    .join('\n');
  assert.match(text, /Add\s+alpha/);
  assert.match(text, /Files: 1 create · 1 update/);
  assert.doesNotMatch(text, /0 remove|chosen ·|required$/m);
  assert.match(text, /Existing content kept: AGENTS.md/);
  assert.match(text, /Skipped instructions · alpha: existing instructions/);
  assert.match(text, /alpha: no agent outputs will be applied/);
  assert.doesNotMatch(text, /local.json|\+.*AGENTS.md|\.agents\/skills/);
});

test('compact review expands unchanged kits and accepts settings-only changes with no kits', async () => {
  const item = selection(
    [kit('alpha'), kit('beta')],
    state(['alpha', 'beta']),
    state(['alpha', 'beta']),
  );
  const ui = await render(reviewScreen, {
    selections: [item],
  });
  assert.match(ui.getScreen(), /No changes to apply/);
  assert.ok(ui.getScreen().split('\n').length <= 12, ui.getScreen());
  assert.doesNotMatch(ui.getScreen(), /Prepare|Selections/);
  assert.match(ui.getScreen(), /Unchanged \(2\)/);
  assert.doesNotMatch(ui.getScreen(), /Keep\s+alpha/);
  focus(ui, 'Unchanged');
  ui.events.keypress('enter');
  assert.match(ui.getScreen(), /Keep\s+alpha/);
  assert.match(ui.getScreen(), /Keep\s+beta/);
  ui.events.keypress('end');
  ui.events.keypress('enter');
  assert.equal(await ui.answer, 'done');
  const empty = await render(reviewScreen, {
    selections: [
      {
        ...selection([], state([]), state([])),
        plan: {
          root: '/project',
          changes: [{ path: '.loadout-personal/local.json', kind: 'update' }],
        },
      },
    ],
  });
  assert.match(empty.getScreen(), /No kits selected/);
  empty.events.keypress('end');
  empty.events.keypress('enter');
  assert.equal(await empty.answer, 'apply');
});

test('file and diff navigation returns to the same file and review action', async () => {
  const item = selection([kit('alpha')], state(['alpha']), state([]));
  item.plan = {
    root: '/project',
    changes: [
      {
        path: 'AGENTS.md',
        kind: 'update',
        before: { content: Buffer.from('old line\n'), mode: 420 },
        after: { content: Buffer.from('new line\n'), mode: 420 },
      },
    ],
  };
  const ui = await render(reviewScreen, {
    selections: [item],
  });
  assert.match(ui.getScreen(), /Remove\s+alpha/);
  assert.match(ui.getScreen(), /› \[ Apply changes \]/);
  ui.events.keypress('tab');
  ui.events.keypress('tab');
  ui.events.keypress('enter');
  focus(ui, '~ AGENTS.md');
  ui.events.keypress('enter');
  assert.match(ui.getScreen(), /File diff/);
  assert.match(ui.getScreen(), /-old line/);
  assert.match(ui.getScreen(), /\+new line/);
  ui.events.keypress('escape');
  assert.match(ui.getScreen(), /› ~ AGENTS.md/);
  ui.events.keypress('escape');
  assert.match(ui.getScreen(), /› \[ View files \]/);
  ui.events.keypress('escape');
  assert.equal(await ui.answer, 'back');
});

test('review is bounded on narrow terminals and all kits remain reachable', async () => {
  const kits = Array.from({ length: 30 }, (_, i) =>
    kit(`workflow-${String(i).padStart(2, '0')}`),
  );
  const item = selection(kits, state([]), state(kits.map(({ id }) => id)));
  const ui = await render(reviewScreen, {
    selections: [item],
    columns: 40,
    rows: 16,
  });
  const check = () => {
    for (const line of ui.getScreen().split('\n'))
      assert.ok(stringWidth(line) <= 40, line);
    assert.ok(ui.getScreen().split('\n').length <= 16);
  };
  check();
  focus(ui, 'workflow-29');
  check();
  ui.events.keypress('tab');
  check();
  ui.events.keypress('escape');
  assert.equal(await ui.answer, 'back');
});

test('no-op review offers Done instead of Apply', async () => {
  const item = selection([kit('alpha')], state(['alpha']), state(['alpha']));
  item.plan = { root: '/project', changes: [] };
  const ui = await render(reviewScreen, {
    selections: [item],
  });
  assert.match(ui.getScreen(), /No changes to apply/);
  assert.doesNotMatch(ui.getScreen(), /Apply changes/);
  assert.match(ui.getScreen(), /› \[ Done \]/);
  ui.events.keypress('enter');
  assert.equal(await ui.answer, 'done');
});
