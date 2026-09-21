import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '@inquirer/testing';
import {
  interactive,
  confirmApply,
  confirmAdoption,
  confirmRetry,
  selectUpdates,
} from '../src/interactive.js';
import { type Kit, type State } from '../src/schema.js';
import { type Target } from '../src/targets.js';

type Options = NonNullable<Parameters<typeof interactive>[2]>;
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
function target(value = kit): Target {
  return {
    label: 'Repository',
    root: '.',
    global: false,
    catalog: { root: '.', kits: new Map([[value.id, value]]) },
    state: structuredClone(empty),
  };
}
const flow = (
  config: { targets: Target[]; review?: Options['review'] },
  context?: Options['context'],
) => {
  // Keep the screen open across prompts, like the real terminal.
  if (context?.output) {
    const output = context.output;
    output.end = (() => output) as typeof output.end;
  }
  return interactive(config.targets, 0, { context, review: config.review });
};
type UI = Awaited<ReturnType<typeof render>>;
function selectAndContinue(ui: UI): void {
  ui.events.keypress('enter'); // Open Personal.
  ui.events.type('exam');
  ui.events.keypress('space');
  ui.events.keypress('down');
  assert.match(ui.getScreen(), /› \[ Back to providers \]/);
  ui.events.keypress('down');
  assert.match(ui.getScreen(), /› \[ Review changes \]/);
  ui.events.keypress('enter');
}
async function cancel(ui: UI): Promise<void> {
  const rejected = assert.rejects(ui.answer, { name: 'ExitPromptError' });
  ui.input.write('\u0003');
  await rejected;
}

test('Escape after Review changes restores the provider, selections, cursor, and editable search', async () => {
  const repository = target({
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
  assert.match(ui.getScreen(), /Include diagrams\?/);
  ui.input.write('\u001b'); // Exercise the real terminal Escape decoder.
  await ui.nextRender();
  assert.match(ui.getScreen(), /Personal/);
  assert.match(ui.getScreen(), /● example/);
  assert.match(ui.getScreen(), /› \[ Review changes \]/);
  assert.match(ui.getScreen(), /\/ exam/);
  ui.events.type('ple');
  assert.match(ui.getScreen(), /\/ example/);
  ui.events.keypress('backspace');
  assert.match(ui.getScreen(), /\/ exampl/);
  ui.events.keypress('space'); // Deselect without changing the saved state.
  ui.events.keypress('down');
  ui.events.keypress('down');
  ui.events.keypress('enter');
  const result = await ui.answer;
  assert.deepEqual(result[0]!.state.selected, []);
  assert.deepEqual(repository.state, empty);
});

test('Escape returns from saved-answer confirmation and choice questions', async () => {
  for (const saved of [false, true]) {
    const repository = target({
      ...kit,
      questions: {
        style: {
          type: 'choice',
          message: 'Choose style',
          choices: ['brief', 'detailed'],
        },
      },
    });
    if (saved) repository.state!.answers = { example: { style: 'brief' } };
    const ui = await render(flow, { targets: [repository] });
    selectAndContinue(ui);
    await ui.nextRender();
    assert.match(ui.getScreen(), saved ? /Change selection\?/ : /Choose style/);
    ui.events.keypress('escape');
    await ui.nextRender();
    assert.match(ui.getScreen(), /● example/);
    ui.events.keypress('enter');
    await ui.nextRender();
    ui.events.keypress('enter');
    const result = await ui.answer;
    assert.equal(result[0]!.state.answers.example!.style, 'brief');
  }
});

test('Escape from review prompts returns to the picker and reviews the revised selections', async () => {
  const source = {
    repo: 'acme/skills',
    ref: 'new',
    skills: ['example'],
    license: 'MIT',
  };
  const updateKit: Kit = {
    ...kit,
    external: source,
    pinned: { ...source, ref: 'old' },
  };
  const reviewPrompts: Array<{
    message: RegExp;
    review: NonNullable<Options['review']>;
  }> = [
    {
      message: /Apply changes\?/,
      review: async (_, context) => {
        await confirmApply(context);
      },
    },
    {
      message: /Keep existing content/,
      review: async (_, context) => {
        await confirmAdoption(['AGENTS.md'], context);
      },
    },
    {
      message: /Download failed/,
      review: async (_, context) => {
        await confirmRetry('example', new Error('Download failed'), context);
      },
    },
    {
      message: /Catalog updates available/,
      review: async (_, context) => {
        await selectUpdates(
          target(updateKit).catalog!,
          { ...empty, selected: ['example'] },
          false,
          context,
        );
      },
    },
  ];
  for (const { message, review } of reviewPrompts) {
    const reviewed: string[][] = [];
    const ui = await render(flow, {
      targets: [target()],
      review: async (selections, context) => {
        reviewed.push(selections[0]!.state.selected);
        await review(selections, context);
      },
    });
    selectAndContinue(ui);
    await ui.nextRender();
    assert.match(ui.getScreen(), message);
    ui.events.keypress('escape');
    await ui.nextRender();
    assert.match(ui.getScreen(), /● example/);
    ui.events.keypress('up');
    ui.events.keypress('up');
    ui.events.keypress('space');
    ui.events.keypress('down');
    ui.events.keypress('down');
    ui.events.keypress('enter');
    await ui.nextRender();
    assert.match(ui.getScreen(), message);
    ui.events.keypress('enter');
    assert.deepEqual((await ui.answer)[0]!.state.selected, []);
    assert.deepEqual(reviewed, [['example'], []]);
  }
});

test('returning from review retains both target selections and the active scope', async () => {
  const repository = target();
  const global = {
    ...target(),
    label: 'Global',
    root: '/home/example',
    global: true,
  };
  const ui = await render(flow, {
    targets: [repository, global],
    review: async (_, context) => {
      await confirmApply(context);
    },
  });
  ui.events.keypress('enter');
  ui.events.keypress('space');
  ui.events.keypress('tab');
  selectAndContinue(ui);
  await ui.nextRender();
  assert.match(ui.getScreen(), /Apply changes\?/);
  ui.events.keypress('escape');
  await ui.nextRender();
  assert.match(ui.getScreen(), /\[● Global\*\]/);
  assert.match(ui.getScreen(), /● example/);
  assert.match(ui.getScreen(), /› \[ Review changes \]/);
  ui.events.keypress('tab');
  assert.match(ui.getScreen(), /\[● Repository[^\]]*\*\]/);
  assert.match(ui.getScreen(), /Browse › Personal/);
  assert.match(ui.getScreen(), /› ● example/);
  ui.events.keypress('tab');
  assert.match(ui.getScreen(), /\/ exam/);
  assert.match(ui.getScreen(), /› \[ Review changes \]/);
  ui.events.keypress('enter');
  await ui.nextRender();
  ui.events.keypress('enter');
  assert.deepEqual(
    (await ui.answer).map(({ target, state }) => [
      target.label,
      state.selected,
    ]),
    [
      ['Repository', ['example']],
      ['Global', ['example']],
    ],
  );
  assert.deepEqual(repository.state, empty);
  assert.deepEqual(global.state, empty);
});

test('Ctrl+C and double Escape still cancel after Review changes', async () => {
  for (const key of ['ctrl-c', 'combined', 'separate']) {
    const ui = await render(flow, {
      targets: [target()],
      review: async (_, context) => {
        await confirmApply(context);
      },
    });
    selectAndContinue(ui);
    await ui.nextRender();
    if (key === 'ctrl-c') await cancel(ui);
    else {
      const rejected = assert.rejects(ui.answer, { name: 'ExitPromptError' });
      if (key === 'combined') ui.input.write('\u001b\u001b');
      else {
        ui.events.keypress('escape');
        await ui.nextRender();
        ui.events.keypress('escape');
      }
      await rejected;
    }
  }
});

test('Back to providers still restores its search after returning from review', async () => {
  const ui = await render(flow, {
    targets: [target()],
    review: async (_, context) => {
      await confirmApply(context);
    },
  });
  ui.events.type('exam');
  ui.events.keypress('enter');
  ui.events.keypress('space');
  ui.events.keypress('up'); // Wrap from the kit to Review changes.
  ui.events.keypress('enter');
  await ui.nextRender();
  ui.events.keypress('escape');
  await ui.nextRender();
  ui.events.keypress('up');
  assert.match(ui.getScreen(), /› \[ Back to providers \]/);
  ui.events.keypress('enter');
  assert.match(ui.getScreen(), /› ▸ Personal[^\n]*1 selected/);
  assert.match(ui.getScreen(), /\/ exam/);
  assert.doesNotMatch(ui.getScreen(), /\[ Back to providers \]/);
  await cancel(ui);
});
