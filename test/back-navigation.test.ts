import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render } from '@inquirer/testing';
import { interactive } from '../src/setup.js';
import {
  BackNavigation,
  confirmApply,
  confirmAdoption,
  confirmRetry,
  selectUpdates,
  type PromptContext,
} from '../src/interactive.js';
import { type Kit, type State } from '../src/schema.js';
import { type Target } from '../src/targets.js';
import { type FetchBytes } from '../src/external.js';
import { loadState } from '../src/storage.js';
import { continuePicker } from './picker-helpers.js';

const kit: Kit = {
  schemaVersion: 1,
  id: 'example',
  directory: '.',
  description: 'Example',
  origin: 'personal',
  requires: [],
  outputs: [],
  questions: {},
};
const empty: State = { schemaVersion: 1, selected: [], answers: {} };
function target(t: TestContext, value = kit, global = false): Target {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    label: global ? 'Global' : 'Repository',
    root,
    global,
    catalog: {
      root,
      kits: new Map([[value.id, { ...value, directory: root }]]),
    },
    state: structuredClone(empty),
  };
}
const flow = (
  config: { targets: Target[]; fetch?: FetchBytes },
  context?: PromptContext,
) => {
  if (context?.output) {
    const output = context.output;
    output.end = (() => output) as typeof output.end;
  }
  return interactive(config.targets, 0, { context, fetch: config.fetch });
};
type UI = Awaited<ReturnType<typeof render>>;
function selectAndContinue(ui: UI): void {
  ui.events.keypress('enter');
  ui.events.type('exam');
  ui.events.keypress('space');
  ui.events.keypress('down');
  assert.match(ui.getScreen(), /› \[ Back to providers \]/);
  ui.events.keypress('down');
  ui.events.keypress('enter');
}
function action(ui: UI, label: string): void {
  for (let i = 0; i < 4 && !ui.getScreen().includes(`› [ ${label} ]`); i++)
    ui.events.keypress('tab');
  assert.ok(ui.getScreen().includes(`› [ ${label} ]`), ui.getScreen());
  ui.events.keypress('enter');
}
async function cancel(ui: UI): Promise<void> {
  const rejected = assert.rejects(ui.answer, { name: 'ExitPromptError' });
  ui.input.write('\u0003');
  await rejected;
}

test('Review changes asks required questions directly; Escape restores the exact picker view', async (t) => {
  const repository = target(t, {
    ...kit,
    questions: {
      diagrams: {
        type: 'boolean',
        message: 'Include diagrams?',
        default: false,
      },
    },
  });
  const ui = await render(flow, { targets: [repository] });
  selectAndContinue(ui);
  await ui.nextRender();
  assert.match(ui.getScreen(), /Repository · example · Include diagrams\?/);
  assert.doesNotMatch(ui.getScreen(), /Prepare|Selections|Change selections/);
  ui.input.write('\u001b');
  await ui.nextRender();
  assert.match(ui.getScreen(), /● example/);
  assert.match(ui.getScreen(), /› \[ Review changes \]/);
  assert.match(ui.getScreen(), /\/ exam/);
  ui.events.type('ple');
  assert.match(ui.getScreen(), /\/ example/);
  ui.events.keypress('backspace');
  assert.match(ui.getScreen(), /\/ exampl/);
  assert.deepEqual(repository.state, empty);
  assert.equal(
    fs.existsSync(path.join(repository.root, '.loadout-personal/local.json')),
    false,
  );
  await cancel(ui);
});

test('completed answers survive returning directly to the picker', async (t) => {
  const repository = target(t, {
    ...kit,
    questions: {
      first: {
        type: 'choice',
        message: 'Choose style',
        choices: ['brief', 'detailed'],
      },
      second: { type: 'boolean', message: 'Include diagrams?', default: false },
    },
  });
  const ui = await render(flow, { targets: [repository] });
  selectAndContinue(ui);
  await ui.nextRender();
  ui.events.keypress('down');
  ui.events.keypress('enter');
  await ui.nextRender();
  assert.match(ui.getScreen(), /Include diagrams/);
  ui.events.keypress('escape');
  await ui.nextRender();
  assert.match(ui.getScreen(), /● example/);
  ui.events.keypress('enter');
  await ui.nextRender();
  assert.match(ui.getScreen(), /Change selections\?/);
  ui.events.keypress('enter');
  await ui.nextRender();
  assert.match(ui.getScreen(), /Include diagrams/);
  ui.events.keypress('enter');
  await ui.nextRender();
  assert.match(ui.getScreen(), /Review changes/);
  assert.match(ui.getScreen(), /first: detailed/);
  action(ui, 'Apply changes');
  const result = await ui.answer;
  assert.deepEqual(result[0]!.state.answers.example, {
    first: 'detailed',
    second: false,
  });
  assert.deepEqual(
    loadState(repository.catalog!).answers,
    result[0]!.state.answers,
  );
  assert.deepEqual(repository.state, empty);
});

test('one confirmation controls saved answers for multiple kits and destinations', async (t) => {
  for (const change of [false, true]) {
    const configured: Kit = {
      ...kit,
      requires: ['helper'],
      questions: {
        diagrams: { type: 'boolean', message: 'Include diagrams?' },
      },
    };
    const targets = [target(t, configured), target(t, configured, true)];
    for (const item of targets) {
      item.catalog!.kits.set('helper', {
        ...configured,
        id: 'helper',
        directory: item.root,
        requires: [],
      });
      item.state!.answers = {
        example: { diagrams: true },
        helper: { diagrams: false },
      };
    }
    const ui = await render(flow, { targets });
    ui.events.keypress('enter');
    ui.events.keypress('space');
    ui.events.keypress('tab');
    ui.events.keypress('enter');
    ui.events.keypress('space');
    ui.events.keypress('up');
    assert.match(ui.getScreen(), /› \[ Review changes \]/);
    ui.events.keypress('enter');
    await ui.nextRender();
    assert.match(ui.getScreen(), /Change selections\?/);
    assert.doesNotMatch(ui.getScreen(), /Change selection\?/);
    for (const item of targets) {
      assert.ok(ui.getScreen().includes(`${item.label} · example`));
      assert.ok(ui.getScreen().includes(`${item.label} · helper`));
    }
    assert.match(ui.getScreen(), /Include diagrams\?\s+Yes/);
    assert.match(ui.getScreen(), /Include diagrams\?\s+No/);
    if (change) ui.events.type('y');
    ui.events.keypress('enter');
    await ui.nextRender();
    if (change) {
      for (const item of targets) {
        for (const id of ['helper', 'example']) {
          assert.ok(ui.getScreen().includes(`${item.label} · ${id}`));
          assert.match(ui.getScreen(), /Change selection\?/);
          assert.match(
            ui.getScreen(),
            id === 'helper'
              ? /Include diagrams\?\s+No/
              : /Include diagrams\?\s+Yes/,
          );
          if (id === 'example') ui.events.type('y');
          ui.events.keypress('enter');
          await ui.nextRender();
          if (id === 'example') {
            assert.ok(
              ui
                .getScreen()
                .includes(`${item.label} · example · Include diagrams?`),
            );
            ui.events.keypress('enter');
            await ui.nextRender();
          }
        }
      }
    }
    assert.match(ui.getScreen(), /Review changes/);
    action(ui, 'Apply changes');
    const result = await ui.answer;
    assert.equal(result.length, 2);
    for (const { state } of result)
      assert.deepEqual(state.answers, {
        example: { diagrams: true },
        helper: { diagrams: false },
      });
  }
});

test('finishing on Repository or Global shows the same saved-answer preview and review', async (t) => {
  const configured: Kit = {
    ...kit,
    questions: {
      diagrams: { type: 'boolean', message: 'Include diagrams?' },
    },
  };
  const targets = [target(t, configured), target(t, configured, true)];
  for (const item of targets) {
    item.state!.selected = ['example'];
    item.state!.answers = { example: { diagrams: item.global } };
  }
  const previews: string[] = [];
  for (const finish of [0, 1]) {
    const ui = await render(flow, { targets });
    ui.events.keypress('tab');
    if (finish === 0) ui.events.keypress('tab');
    continuePicker(ui);
    await ui.nextRender();
    previews.push(ui.getScreen());
    assert.match(
      ui.getScreen(),
      /Repository · example\s+Include diagrams\?\s+No/,
    );
    assert.match(ui.getScreen(), /Global · example\s+Include diagrams\?\s+Yes/);
    assert.match(ui.getScreen(), /Change selections\?/);
    ui.events.keypress('enter');
    await ui.nextRender();
    assert.match(ui.getScreen(), /Review changes/);
    assert.match(ui.getScreen(), /Repository/);
    assert.match(ui.getScreen(), /Global/);
    await cancel(ui);
  }
  assert.equal(previews[0], previews[1]);
});

test('Escape from either selection confirmation returns to the picker', async (t) => {
  for (const perKit of [false, true]) {
    const repository = target(t, {
      ...kit,
      questions: {
        diagrams: { type: 'boolean', message: 'Include diagrams?' },
      },
    });
    repository.state!.answers = { example: { diagrams: true } };
    const ui = await render(flow, { targets: [repository] });
    selectAndContinue(ui);
    await ui.nextRender();
    assert.match(ui.getScreen(), /Change selections\?/);
    if (perKit) {
      ui.events.type('y');
      ui.events.keypress('enter');
      await ui.nextRender();
      assert.match(ui.getScreen(), /Change selection\?/);
    }
    ui.events.keypress('escape');
    await ui.nextRender();
    assert.match(ui.getScreen(), /● example/);
    assert.match(ui.getScreen(), /› \[ Review changes \]/);
    await cancel(ui);
  }
});

test('review and files have a Back hierarchy that retains both scopes and browsing positions', async (t) => {
  const repository = target(t);
  const global = target(t, kit, true);
  const ui = await render(flow, { targets: [repository, global] });
  ui.events.keypress('enter');
  ui.events.keypress('space');
  ui.events.keypress('tab');
  selectAndContinue(ui);
  await ui.nextRender();
  assert.match(ui.getScreen(), /Repository/);
  assert.match(ui.getScreen(), /Global/);
  assert.match(ui.getScreen(), /Review changes/);
  assert.doesNotMatch(ui.getScreen(), /Prepare|Selections/);
  assert.doesNotMatch(
    await ui.getFullOutput(),
    /Prepare changes|\[Selections\]|\[Prepare\]/,
  );
  action(ui, 'View files');
  assert.match(ui.getScreen(), /Files · Enter to inspect a diff/);
  ui.events.keypress('escape');
  assert.match(ui.getScreen(), /Review changes/);
  ui.events.keypress('escape');
  await ui.nextRender();
  assert.match(ui.getScreen(), /\[● Global\*\]/);
  assert.match(ui.getScreen(), /● example/);
  assert.match(ui.getScreen(), /› \[ Review changes \]/);
  ui.events.keypress('tab');
  assert.match(ui.getScreen(), /\[● Repository[^\]]*\*\]/);
  assert.match(ui.getScreen(), /› ● example/);
  ui.events.keypress('tab');
  assert.match(ui.getScreen(), /\/ exam/);
  assert.deepEqual(repository.state, empty);
  assert.deepEqual(global.state, empty);
  await cancel(ui);
});

test('deselecting a configured kit before switching scope does not resurrect its draft selection', async (t) => {
  const repository = target(t, {
    ...kit,
    questions: {
      diagrams: {
        type: 'boolean',
        message: 'Include diagrams?',
        default: false,
      },
    },
  });
  const global = target(t, kit, true);
  const ui = await render(flow, { targets: [repository, global] });
  selectAndContinue(ui);
  await ui.nextRender();
  ui.events.keypress('enter');
  await ui.nextRender();
  assert.match(ui.getScreen(), /Review changes/);
  ui.events.keypress('escape');
  await ui.nextRender();
  ui.events.keypress('up');
  ui.events.keypress('up');
  ui.events.keypress('space');
  ui.events.keypress('tab');
  selectAndContinue(ui);
  await ui.nextRender();
  assert.match(ui.getScreen(), /Review changes/);
  action(ui, 'Apply changes');
  const result = await ui.answer;
  assert.deepEqual(
    result.map(({ state }) => state.selected),
    [[], ['example']],
  );
  assert.deepEqual(loadState(repository.catalog!).selected, []);
  assert.deepEqual(loadState(global.catalog!).selected, ['example']);
});

test('a filesystem change after review blocks apply and offers retry or Back to kits', async (t) => {
  const repository = target(t);
  const ui = await render(flow, { targets: [repository] });
  selectAndContinue(ui);
  await ui.nextRender();
  assert.match(ui.getScreen(), /Review changes/);
  const local = path.join(repository.root, '.loadout-personal/local.json');
  fs.mkdirSync(path.dirname(local));
  fs.writeFileSync(local, 'concurrent edit');
  action(ui, 'Apply changes');
  await ui.nextRender();
  assert.match(ui.getScreen(), /Could not finish/);
  assert.match(ui.getScreen(), /Back to kits/);
  assert.equal(fs.readFileSync(local, 'utf8'), 'concurrent edit');
  assert.equal(
    fs.existsSync(
      path.join(repository.root, '.loadout-personal/generated.json'),
    ),
    false,
  );
  ui.events.keypress('escape');
  await ui.nextRender();
  assert.match(ui.getScreen(), /● example/);
  await cancel(ui);
});

test('all scopes finish preparation before review; retry and Back save nothing', async (t) => {
  const repository = target(t);
  const global = target(
    t,
    {
      ...kit,
      external: {
        repo: 'acme/skills',
        ref: '1'.repeat(40),
        skills: ['skills/example'],
        license: 'LICENSE',
      },
    },
    true,
  );
  let requests = 0;
  const ui = await render(flow, {
    targets: [repository, global],
    fetch: async () => {
      requests++;
      throw new Error('Connection lost');
    },
  });
  ui.events.keypress('enter');
  ui.events.keypress('space');
  ui.events.keypress('tab');
  selectAndContinue(ui);
  await ui.nextRender();
  assert.equal(requests, 2);
  assert.match(ui.getScreen(), /Repository · Ready/);
  assert.match(ui.getScreen(), /Connection lost/);
  assert.doesNotMatch(ui.getScreen(), /Files:|\[Review\]|Apply changes/);
  ui.events.keypress('enter');
  await ui.nextRender();
  assert.equal(requests, 4);
  ui.events.keypress('escape');
  await ui.nextRender();
  assert.match(ui.getScreen(), /● example/);
  for (const item of [repository, global])
    assert.equal(
      fs.existsSync(path.join(item.root, '.loadout-personal')),
      false,
    );
  await cancel(ui);
});

test('Escape aborts in-flight requests without retrying or applying', async (t) => {
  const repository = target(t, {
    ...kit,
    external: {
      repo: 'acme/skills',
      ref: '1'.repeat(40),
      skills: ['skills/example'],
      license: 'LICENSE',
    },
  });
  let requests = 0;
  let aborted = false;
  const ui = await render(flow, {
    targets: [repository],
    fetch: async (_url, _limit, signal) => {
      requests++;
      return new Promise((_resolve, reject) =>
        signal!.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(signal!.reason);
          },
          { once: true },
        ),
      );
    },
  });
  selectAndContinue(ui);
  await ui.nextRender();
  // Only a real wait reveals the small download status.
  await new Promise((resolve) => setTimeout(resolve, 180));
  await ui.nextRender();
  assert.match(ui.getScreen(), /Downloading example/);
  ui.events.keypress('escape');
  await ui.nextRender();
  assert.equal(aborted, true);
  assert.equal(requests, 1);
  assert.match(ui.getScreen(), /● example/);
  assert.equal(
    fs.existsSync(path.join(repository.root, '.loadout-personal')),
    false,
  );
  await cancel(ui);
});

test('Ctrl+C cancels from review; double Escape still cancels in the picker', async (t) => {
  for (const stage of ['picker', 'review']) {
    const ui = await render(flow, { targets: [target(t)] });
    if (stage === 'picker') {
      const rejected = assert.rejects(ui.answer, { name: 'ExitPromptError' });
      ui.input.write('\u001b\u001b');
      await rejected;
    } else {
      selectAndContinue(ui);
      await ui.nextRender();
      await cancel(ui);
    }
  }
});

test('Back to providers restores its search after leaving review', async (t) => {
  const ui = await render(flow, { targets: [target(t)] });
  ui.events.type('exam');
  ui.events.keypress('enter');
  ui.events.keypress('space');
  ui.events.keypress('up');
  ui.events.keypress('enter');
  await ui.nextRender();
  action(ui, 'Back to kits');
  await ui.nextRender();
  ui.events.keypress('up');
  assert.match(ui.getScreen(), /› \[ Back to providers \]/);
  ui.events.keypress('enter');
  assert.match(ui.getScreen(), /› ▸ Personal[^\n]*1 selected/);
  assert.match(ui.getScreen(), /\/ exam/);
  await cancel(ui);
});

test('configuration helpers propagate Escape as Back navigation', async (t) => {
  const source = {
    repo: 'acme/skills',
    ref: 'new',
    skills: ['example'],
    license: 'MIT',
  };
  const prompts = [
    (context?: PromptContext) => confirmApply(context),
    (context?: PromptContext) => confirmAdoption(['AGENTS.md'], context),
    (context?: PromptContext) =>
      confirmRetry('example', new Error('Download failed'), context),
    (context?: PromptContext) =>
      selectUpdates(
        target(t, {
          ...kit,
          external: source,
          pinned: { ...source, ref: 'old' },
        }).catalog!,
        { ...empty, selected: ['example'] },
        false,
        context,
      ),
  ];
  for (const prompt of prompts) {
    const ui = await render(
      async (_config: object, context?: PromptContext) => {
        await prompt(context);
      },
      {},
    );
    const rejected = assert.rejects(ui.answer, BackNavigation);
    ui.events.keypress('escape');
    await rejected;
  }
});
