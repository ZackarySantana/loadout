import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '@inquirer/testing';
import {
  configureSelection,
  confirmSelectionChanges,
  confirmApply,
} from '../src/interactive.js';
import { type Kit, type State } from '../src/schema.js';
import { type Target } from '../src/targets.js';

const kit: Kit = {
  schemaVersion: 1,
  id: 'example',
  directory: '.',
  description: 'Example',
  requires: [],
  outputs: [],
  questions: {
    diagrams: { type: 'boolean', message: 'Include diagrams?', default: false },
  },
};
const target: Target = {
  label: 'Repository',
  root: '.',
  global: false,
  catalog: { root: '.', kits: new Map([[kit.id, kit]]) },
};
const saved: State = {
  schemaVersion: 1,
  selected: ['example'],
  answers: { example: { diagrams: true } },
};
const prompt = (
  config: { target: Target; state: State; changeSelections?: boolean },
  context?: Parameters<typeof configureSelection>[2],
) => {
  // Inquirer ends its output after each question. Keep the test screen open
  // across the whole flow, as process.stdout stays open in a real terminal.
  if (context?.output) {
    const output = context.output;
    output.end = (() => output) as typeof output.end;
  }
  return configureSelection(
    config.target,
    config.state,
    context,
    undefined,
    config.changeSelections,
  );
};

test('overall confirmation previews active questions and marks missing and invalid answers', async () => {
  const configured: Kit = {
    ...kit,
    questions: {
      ...kit.questions,
      style: { type: 'choice', message: 'Choose style', choices: ['brief'] },
      extra: { type: 'boolean', message: 'Include extras?' },
    },
  };
  const ui = await render(
    (selections: Parameters<typeof confirmSelectionChanges>[0], context) =>
      confirmSelectionChanges(selections, context),
    [
      {
        target: {
          ...target,
          catalog: { root: '.', kits: new Map([[kit.id, configured]]) },
        },
        state: {
          ...saved,
          answers: { example: { diagrams: true, style: 'removed-choice' } },
        },
      },
    ],
  );
  assert.match(ui.getScreen(), /Repository · example/);
  assert.match(ui.getScreen(), /Include diagrams\?\s+Yes/);
  assert.match(ui.getScreen(), /Include extras\?\s+Not answered/);
  assert.match(
    ui.getScreen(),
    /Choose style\s+removed-choice \(invalid saved answer\)/,
  );
  assert.match(ui.getScreen(), /Change selections\?/);
  ui.events.keypress('enter');
  assert.equal(await ui.answer, false);
});

test('kit confirmation previews saved answers and reuses them by default', async () => {
  const ui = await render(prompt, { target, state: saved });
  assert.match(ui.getScreen(), /Change selection\?/);
  assert.match(ui.getScreen(), /Include diagrams\?\s+Yes/);
  ui.events.keypress('enter');
  assert.deepEqual(await ui.answer, saved);
});

test('choosing to change selection asks the kit questions and keeps the saved state untouched', async () => {
  const ui = await render(prompt, { target, state: saved });
  ui.events.type('y');
  ui.events.keypress('enter');
  await ui.nextRender();
  assert.match(ui.getScreen(), /Include diagrams/);
  ui.events.type('n');
  ui.events.keypress('enter');
  assert.equal((await ui.answer).answers.example!.diagrams, false);
  assert.equal(saved.answers.example!.diagrams, true);
});

test('new kits ask their questions even when a default is provided', async () => {
  const ui = await render(prompt, { target, state: { ...saved, answers: {} } });
  assert.match(ui.getScreen(), /Include diagrams/);
  assert.doesNotMatch(ui.getScreen(), /Change selection/);
  ui.events.keypress('enter');
  assert.equal((await ui.answer).answers.example!.diagrams, false);
});

test('declining changes still collects missing and invalid answers', async () => {
  const modified = {
    ...kit,
    questions: {
      ...kit.questions,
      style: {
        type: 'choice' as const,
        message: 'Choose style',
        choices: ['brief', 'detailed'],
      },
    },
  };
  for (const answer of [undefined, 'removed-choice']) {
    const state = {
      ...saved,
      answers: {
        example: {
          ...saved.answers.example!,
          ...(answer ? { style: answer } : {}),
        },
      },
    };
    const ui = await render(prompt, {
      target: {
        ...target,
        catalog: { root: '.', kits: new Map([[modified.id, modified]]) },
      },
      state,
    });
    assert.match(ui.getScreen(), /Include diagrams\?\s+Yes/);
    assert.match(
      ui.getScreen(),
      answer
        ? /Choose style\s+removed-choice \(invalid saved answer\)/
        : /Choose style\s+Not answered/,
    );
    ui.events.keypress('enter');
    await ui.nextRender();
    assert.match(ui.getScreen(), /Choose style/);
    ui.events.keypress('enter');
    assert.deepEqual((await ui.answer).answers.example, {
      diagrams: true,
      style: 'brief',
    });
  }
});

test('kit preview shows every question and editing defaults to the saved answers', async () => {
  const configured: Kit = {
    ...kit,
    questions: {
      ...kit.questions,
      style: {
        type: 'choice',
        message: 'Choose style',
        choices: ['brief', 'detailed'],
      },
    },
  };
  const state: State = {
    ...saved,
    answers: { example: { diagrams: false, style: 'detailed' } },
  };
  const ui = await render(prompt, {
    target: {
      ...target,
      catalog: { root: '.', kits: new Map([[configured.id, configured]]) },
    },
    state,
  });
  assert.match(ui.getScreen(), /Include diagrams\?\s+No/);
  assert.match(ui.getScreen(), /Choose style\s+detailed/);
  assert.match(ui.getScreen(), /Change selection\?/);
  ui.events.type('y');
  ui.events.keypress('enter');
  await ui.nextRender();
  assert.match(ui.getScreen(), /Repository · example · Include diagrams\?/);
  ui.events.keypress('enter');
  await ui.nextRender();
  assert.match(ui.getScreen(), /Repository · example · Choose style/);
  ui.events.keypress('enter');
  assert.deepEqual(await ui.answer, state);
});

test('skipping selection changes still asks new, missing, and invalid questions', async () => {
  for (const diagrams of [undefined, 'invalid']) {
    const state: State = {
      ...saved,
      answers: { example: diagrams === undefined ? {} : { diagrams } },
    };
    const ui = await render(prompt, {
      target,
      state,
      changeSelections: false,
    });
    assert.match(ui.getScreen(), /Repository · example · Include diagrams\?/);
    assert.doesNotMatch(ui.getScreen(), /Change selection/);
    ui.events.type('y');
    ui.events.keypress('enter');
    assert.equal((await ui.answer).answers.example!.diagrams, true);
  }
});

test('apply confirmation names the destinations being changed', async () => {
  for (const scopes of [['Repository'], ['Global'], ['Repository', 'Global']]) {
    const ui = await render(
      (config: string[], context?: Parameters<typeof confirmApply>[0]) =>
        confirmApply(context, config),
      scopes,
    );
    assert.ok(
      ui.getScreen().includes(`Apply changes to ${scopes.join(' and ')}?`),
    );
    ui.events.type('n');
    ui.events.keypress('enter');
    assert.equal(await ui.answer, false);
  }
});
