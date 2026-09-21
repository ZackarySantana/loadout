import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '@inquirer/testing';
import stringWidth from 'string-width';
import { continuePicker } from './picker-helpers.js';
import { kitPicker } from '../src/picker.js';
import { type Catalog, type Kit } from '../src/schema.js';

const makeKit = (
  id: string,
  description: string,
  requires: string[] = [],
): Kit => ({
  schemaVersion: 1,
  id,
  description,
  requires,
  questions: {},
  outputs: [],
  directory: '.',
});
const catalog: Catalog = {
  root: '.',
  kits: new Map([
    [
      'code-navigation',
      makeKit('code-navigation', 'Find code and understand package boundaries'),
    ],
    [
      'graphiffy',
      makeKit('graphiffy', 'Explore repository relationships', [
        'code-navigation',
      ]),
    ],
    ['testing', makeKit('testing', 'Choose and run focused tests')],
  ]),
};

test('picker toggles in place, preserves focus, filters, and marks dependencies', async () => {
  const { events, answer, getScreen, getFullOutput } = await render(kitPicker, {
    catalog,
    selected: [],
    columns: 80,
    rows: 24,
  });
  assert.match(getScreen(), /\[Kits\]/);
  assert.doesNotMatch(getScreen(), /Which agents|repo supplies|Done —/);
  events.keypress('down');
  events.keypress('space');
  assert.match(getScreen(), /● graphiffy/);
  assert.match(getScreen(), /◆ code-navigation/);
  assert.match(getScreen(), /1 selected · 1 required/);
  events.keypress('space');
  assert.match(getScreen(), /○ graphiffy/);
  assert.doesNotMatch(getScreen(), /◆ code-navigation/);
  events.type('relationships');
  assert.match(getScreen(), /graphiffy/);
  assert.doesNotMatch(getScreen(), /Choose and run focused tests/);
  events.keypress('space');
  assert.match(getScreen(), /● graphiffy/);
  events.keypress('escape');
  assert.match(getScreen(), /◆ code-navigation/);
  events.keypress('space'); // Keep the dependency explicitly.
  assert.match(getScreen(), /● code-navigation/);
  assert.match(getScreen(), /2 selected/);
  assert.doesNotMatch(getScreen(), /◆/);
  continuePicker({ events, getScreen });
  assert.deepEqual(await answer, ['code-navigation', 'graphiffy']);
  const terminal = await getFullOutput();
  assert.doesNotMatch(terminal, /Choose your kits|Which agents/);
  assert.equal((terminal.match(/2 selected/g) ?? []).length, 1);
});

test('narrow terminal layout fits without losing navigation or selected kits', async () => {
  const { events, answer, getScreen } = await render(kitPicker, {
    catalog,
    selected: ['testing'],
    columns: 40,
    rows: 16,
  });
  assert.match(getScreen(), /LOADOUT/);
  for (const line of getScreen().split('\n'))
    assert.ok(stringWidth(line) <= 40, line);
  events.type('not-found');
  assert.match(getScreen(), /No matching kits/);
  events.keypress('backspace');
  events.keypress('escape');
  continuePicker({ events, getScreen });
  assert.deepEqual(await answer, ['testing']);
});

test('picker supports empty catalogs and cancellation', async () => {
  const empty = await render(kitPicker, {
    catalog: { root: '.', kits: new Map() },
    selected: [],
  });
  assert.match(empty.getScreen(), /No kits in this catalog/);
  assert.doesNotMatch(empty.getScreen(), /Review Repository|before applying/);
  continuePicker(empty);
  assert.deepEqual(await empty.answer, []);
  const cancelled = await render(kitPicker, {
    catalog,
    selected: ['testing'],
  });
  const rejected = assert.rejects(cancelled.answer, {
    name: 'ExitPromptError',
  });
  cancelled.events.keypress({ name: 'c', ctrl: true });
  await rejected;
});

function externalKit(id: string, repo: string, installed = false): Kit {
  const external = {
    repo,
    ref: '2'.repeat(40),
    skills: [`skills/${id}`],
    license: 'LICENSE',
  };
  return {
    ...makeKit(id, `Workflow for ${id}`),
    external,
    ...(installed ? { pinned: { ...external, ref: '1'.repeat(40) } } : {}),
  };
}

test('separate repository, installed, and provider browsing preserves selections and searches included skills', async () => {
  const remote = externalKit('remote-alpha', 'acme/skills', true);
  const bundled = externalKit('interview', 'other/skills');
  bundled.external!.skills.push('skills/grilling');
  const mixed = {
    ...catalog,
    kits: new Map([
      ...catalog.kits,
      [remote.id, remote],
      [bundled.id, bundled],
    ]),
  };
  const { events, answer, getScreen } = await render(kitPicker, {
    catalog: mixed,
    selected: ['remote-alpha'],
    columns: 80,
    rows: 24,
  });
  assert.doesNotMatch(getScreen(), /remote-alpha|acme\/skills|other\/skills/);
  events.keypress('left');
  assert.match(getScreen(), /\[Installed\]/);
  assert.match(getScreen(), /● remote-alpha/);
  assert.match(getScreen(), /Catalog update/);
  assert.doesNotMatch(getScreen(), /code-navigation|interview/);
  events.keypress('left');
  assert.match(getScreen(), /\[Browse\]/);
  assert.match(getScreen(), /acme\/skills/);
  assert.match(getScreen(), /other\/skills/);
  assert.doesNotMatch(getScreen(), /remote-alpha|Workflow for interview/);
  events.type('grilling');
  assert.doesNotMatch(getScreen(), /acme\/skills/);
  events.keypress('space');
  assert.match(getScreen(), /○ interview/);
  assert.match(getScreen(), /Workflow for interview/);
  events.keypress('space');
  events.keypress('escape'); // Clear the retained search.
  await new Promise((resolve) => setTimeout(resolve, 550));
  events.keypress('escape'); // Return to providers.
  assert.match(getScreen(), /other\/skills[^\n]*1 selected/);
  events.keypress('right');
  assert.match(getScreen(), /● interview/);
  assert.match(getScreen(), /● remote-alpha/);
  events.keypress('space'); // Disable the downloaded kit, retaining its snapshot row.
  assert.match(getScreen(), /○ remote-alpha[^\n]*Will uninstall/);
  assert.doesNotMatch(getScreen(), /Catalog update/);
  continuePicker({ events, getScreen });
  assert.deepEqual(await answer, ['interview']);
});

test('installed bundled kits retain pending removals and allow undo across tabs', async () => {
  const bundled = {
    ...makeKit('loadout-testing', 'Run tests'),
    origin: 'bundled' as const,
  };
  const ui = await render(kitPicker, {
    catalog: { root: '.', kits: new Map([[bundled.id, bundled]]) },
    selected: [bundled.id],
    columns: 80,
    rows: 24,
  });
  ui.events.keypress('right');
  ui.events.keypress('space');
  assert.match(ui.getScreen(), /› ○ loadout-testing[^\n]*Will uninstall/);
  assert.match(ui.getScreen(), /Select again to keep/);
  ui.events.keypress('left');
  ui.events.keypress('right');
  assert.match(ui.getScreen(), /○ loadout-testing[^\n]*Will uninstall/);
  ui.events.keypress('enter');
  assert.match(ui.getScreen(), /● loadout-testing/);
  assert.doesNotMatch(ui.getScreen(), /● loadout-testing[^\n]*selected/);
  assert.doesNotMatch(ui.getScreen(), /Will uninstall/);
  ui.events.keypress('space');
  continuePicker(ui);
  assert.deepEqual(await ui.answer, []);
});

test('pending uninstalls respect shared dependencies and exclude cached inactive kits', async () => {
  const kits = [
    {
      ...makeKit('first', 'First kit', ['shared']),
      origin: 'bundled' as const,
    },
    {
      ...makeKit('second', 'Second kit', ['shared']),
      origin: 'bundled' as const,
    },
    { ...makeKit('shared', 'Shared dependency'), origin: 'bundled' as const },
    externalKit('cached', 'acme/skills', true),
  ];
  const ui = await render(kitPicker, {
    catalog: { root: '.', kits: new Map(kits.map((kit) => [kit.id, kit])) },
    selected: ['first', 'second'],
    columns: 80,
    rows: 40,
  });
  ui.events.keypress('right');
  ui.events.keypress('space');
  assert.match(ui.getScreen(), /○ first[^\n]*Will uninstall/);
  assert.match(ui.getScreen(), /◆ shared[^\n]*required/);
  ui.events.keypress('down');
  ui.events.keypress('enter');
  assert.match(ui.getScreen(), /○ second[^\n]*Will uninstall/);
  assert.match(ui.getScreen(), /○ shared[^\n]*Will uninstall/);
  assert.doesNotMatch(ui.getScreen(), /cached[^\n]*Will uninstall/);
  continuePicker(ui);
  assert.deepEqual(await ui.answer, []);
});

test('large provider catalogs stay paginated and searchable within terminal bounds', async () => {
  const kits = new Map<string, Kit>();
  for (let i = 0; i < 120; i++) {
    const kit = externalKit(
      `remote-${i}`,
      `provider-${Math.floor(i / 10)}/skills`,
    );
    kits.set(kit.id, kit);
  }
  const { events, answer, getScreen } = await render(kitPicker, {
    catalog: { root: '.', kits },
    selected: [],
    columns: 40,
    rows: 16,
  });
  assert.match(getScreen(), /of 12/);
  for (const line of getScreen().split('\n'))
    assert.ok(stringWidth(line) <= 40, line);
  assert.ok(getScreen().split('\n').length <= 16);
  events.type('remote-119');
  events.keypress('space');
  assert.match(getScreen(), /remote-119/);
  events.keypress('space');
  continuePicker({ events, getScreen });
  assert.deepEqual(await answer, ['remote-119']);
});

test('left/right switch tabs and arrow navigation keeps subsequent typing at the end of the filter', async () => {
  const { events, input, answer, getScreen } = await render(kitPicker, {
    catalog,
    selected: [],
  });
  events.type('code');
  input.write('\u001b[B');
  events.type('-navigation');
  assert.match(getScreen(), /\/ code-navigation/);
  assert.match(getScreen(), /○ code-navigation/);
  input.write('\u001b[C');
  assert.match(getScreen(), /\[Browse\]/);
  input.write('\u001b[C');
  assert.match(getScreen(), /\[Installed\]/);
  input.write('\u001b[D');
  input.write('\u001b[D');
  assert.match(getScreen(), /\[Kits\]/);
  events.type('testing');
  assert.match(getScreen(), /\/ testing/);
  events.keypress('space');
  continuePicker({ events, getScreen });
  assert.deepEqual(await answer, ['testing']);
});

test('standalone Escape clears promptly while split arrow sequences still navigate', async () => {
  const ui = await render(kitPicker, { catalog, selected: [] });
  ui.events.type('code');
  await ui.nextRender();
  const start = performance.now();
  ui.input.write('\u001b');
  await ui.nextRender();
  const elapsed = performance.now() - start;
  assert.doesNotMatch(ui.getScreen(), /\/ code/);
  ui.input.write('\u001b');
  await new Promise((resolve) => setTimeout(resolve, 10));
  ui.input.write('[C');
  assert.match(ui.getScreen(), /\[Browse\]/);
  ui.input.write('\u001b[D');
  continuePicker(ui);
  await ui.answer;
  assert.ok(elapsed < 300, `Escape took ${elapsed.toFixed(0)}ms`);
});

test('double Escape cancels for combined and separate terminal events, while other keys reset it', async () => {
  for (const combined of [true, false]) {
    const ui = await render(kitPicker, { catalog, selected: ['testing'] });
    ui.events.type('code');
    ui.events.keypress('escape');
    ui.events.keypress('down'); // An intervening key starts a new Escape pair.
    ui.events.keypress('escape');
    assert.match(ui.getScreen(), /selected/);
    const rejected = assert.rejects(ui.answer, { name: 'ExitPromptError' });
    if (combined) ui.input.write('\u001b\u001b');
    else ui.events.keypress('escape');
    await rejected;
  }
});

test('live resizing expands beyond the previous width cap and preserves search and selections', async (t) => {
  const original = Object.getOwnPropertyDescriptors(process.stdout);
  t.after(() => {
    for (const key of ['columns', 'rows']) {
      if (original[key])
        Object.defineProperty(process.stdout, key, original[key]!);
      else Reflect.deleteProperty(process.stdout, key);
    }
  });
  const resize = (columns: number, rows: number) => {
    Object.defineProperties(process.stdout, {
      columns: { value: columns, configurable: true, writable: true },
      rows: { value: rows, configurable: true, writable: true },
    });
    process.stdout.emit('resize');
  };
  resize(80, 24);
  const description =
    'Detailed guidance for navigating a large repository and understanding its package boundaries, entry points, and dependencies.';
  const kit = makeKit('navigation', description);
  const ui = await render(kitPicker, {
    catalog: { root: '.', kits: new Map([[kit.id, kit]]) },
    selected: [],
  });
  const maxWidth = () =>
    Math.max(
      ...ui
        .getScreen()
        .split('\n')
        .map((line) => stringWidth(line)),
    );
  assert.equal(maxWidth(), 78);
  assert.doesNotMatch(ui.getScreen(), /entry points, and dependencies/);
  ui.events.type('navigation');
  ui.events.keypress('space');
  resize(160, 24);
  assert.equal(maxWidth(), 158);
  assert.ok(ui.getScreen().includes(description));
  assert.match(ui.getScreen(), /\/ navigation/);
  assert.match(ui.getScreen(), /● navigation/);
  assert.match(
    ui.getScreen(),
    /↑↓ move[^\n]*Space toggle[^\n]*←→ tabs[^\n]*Esc clear/,
  );
  resize(40, 16);
  assert.ok(maxWidth() <= 40);
  assert.match(ui.getScreen(), /LOADOUT/);
  assert.match(ui.getScreen(), /\/ navigation/);
  assert.match(ui.getScreen(), /● navigation/);
  assert.match(ui.getScreen(), /Space toggle · ←→ tabs · Esc clear/);
  resize(100, 24);
  assert.equal(maxWidth(), 98);
  continuePicker(ui);
  assert.deepEqual(await ui.answer, ['navigation']);
});

test('Space and Enter open and toggle without continuing; only Review changes finishes', async () => {
  const first = externalKit('first', 'alpha/skills', true);
  const second = externalKit('second', 'beta/skills');
  const mixed = {
    root: '.',
    kits: new Map([
      [first.id, first],
      [second.id, second],
    ]),
  };
  for (const key of ['enter', 'space'] as const) {
    const ui = await render(kitPicker, {
      catalog: mixed,
      selected: [],
      columns: 80,
      rows: 24,
    });
    let finished = false;
    void ui.answer.then(() => {
      finished = true;
    });
    assert.match(ui.getScreen(), /alpha\/skills[^\n]*1 downloaded/);
    assert.match(ui.getScreen(), /\[ Review changes \]/);
    ui.events.keypress(key);
    assert.match(ui.getScreen(), /○ first/);
    ui.events.keypress(key);
    assert.match(ui.getScreen(), /● first/);
    ui.events.keypress('escape');
    assert.match(
      ui.getScreen(),
      /alpha\/skills[^\n]*1 selected · 1 downloaded/,
    );
    ui.events.keypress('down');
    ui.events.keypress(key);
    ui.events.keypress(key);
    assert.match(ui.getScreen(), /● second/);
    ui.events.keypress('escape');
    assert.match(ui.getScreen(), /beta\/skills[^\n]*1 selected/);
    assert.doesNotMatch(ui.getScreen(), /beta\/skills[^\n]*downloaded/);
    await Promise.resolve();
    assert.equal(finished, false);
    continuePicker(ui, key);
    assert.deepEqual(await ui.answer, ['first', 'second']);
  }
});

test('Review changes follows kits, with Back to providers first inside a provider', async () => {
  const remote = externalKit('remote', 'acme/skills', true);
  const mixed = {
    ...catalog,
    kits: new Map([...catalog.kits, [remote.id, remote]]),
  };
  for (const view of ['Kits', 'Provider', 'Installed']) {
    const ui = await render(kitPicker, {
      catalog: mixed,
      selected: [],
      columns: 40,
      rows: 16,
    });
    if (view === 'Provider') {
      ui.events.keypress('right');
      ui.events.keypress('enter');
    } else if (view === 'Installed') ui.events.keypress('left');
    const id = view === 'Kits' ? 'testing' : 'remote';
    ui.events.type(id);
    ui.events.keypress('enter');
    assert.match(ui.getScreen(), new RegExp(`● ${id}`));
    assert.match(ui.getScreen(), /\[ Review changes \]/);
    ui.events.keypress('down');
    if (view === 'Provider') {
      assert.match(ui.getScreen(), /› \[ Back to providers \]/);
      ui.events.keypress('down');
      assert.match(
        ui.getScreen(),
        /\[ Back to providers \][^\n]*\n[^\n]*› \[ Review changes \]/,
      );
    } else {
      assert.doesNotMatch(ui.getScreen(), /\[ Back to providers \]/);
      assert.match(ui.getScreen(), /─\n[^\n]*› \[ Review changes \]/);
    }
    assert.match(ui.getScreen(), /› \[ Review changes \]/);
    assert.ok(ui.getScreen().split('\n').length <= 16);
    ui.events.keypress('space');
    assert.deepEqual(await ui.answer, [id]);
  }
});

test('Back and Escape restore provider-list focus and editable search while retaining selections', async () => {
  const kits = [
    externalKit('first', 'alpha/vendor'),
    externalKit('second', 'beta/vendor'),
    externalKit('third', 'gamma/other'),
  ];
  for (const key of ['enter', 'space', 'escape'] as const) {
    const ui = await render(kitPicker, {
      catalog: { root: '.', kits: new Map(kits.map((kit) => [kit.id, kit])) },
      selected: [],
    });
    ui.events.type('vendor');
    ui.events.keypress('down');
    ui.events.keypress('enter');
    assert.match(ui.getScreen(), /Browse › beta\/vendor/);
    ui.events.keypress('space');
    ui.events.keypress('escape'); // Clear the inherited search, staying inside.
    assert.match(ui.getScreen(), /Browse › beta\/vendor/);
    assert.match(ui.getScreen(), /● second/);
    if (key === 'escape') {
      ui.events.keypress('down'); // Reset the double-Escape cancellation pair.
      ui.events.keypress('escape');
    } else {
      ui.events.type('no-match');
      assert.match(ui.getScreen(), /No matching kits/);
      assert.match(ui.getScreen(), /› \[ Back to providers \]/);
      assert.match(ui.getScreen(), /Keeps your selections/);
      ui.events.keypress(key); // Back navigates even with an active filter.
    }
    assert.match(ui.getScreen(), /› ▸ beta\/vendor[^\n]*1 selected/);
    assert.match(ui.getScreen(), /\/ vendor/);
    assert.doesNotMatch(ui.getScreen(), /gamma\/other|\[ Back to providers \]/);
    ui.events.type('x');
    assert.match(ui.getScreen(), /\/ vendorx/);
    ui.events.keypress('backspace');
    continuePicker(ui);
    assert.deepEqual(await ui.answer, ['second']);
  }
});

test('provider footer fits narrow terminals and Review accepts removal-only changes', async () => {
  const kit = externalKit('remote', 'acme/skills', true);
  for (const columns of [22, 40, 80]) {
    const ui = await render(kitPicker, {
      catalog: { root: '.', kits: new Map([[kit.id, kit]]) },
      selected: ['remote'],
      columns,
      rows: 24,
    });
    ui.events.keypress('enter');
    ui.events.keypress('space'); // Remove the only installed kit.
    ui.events.keypress('down');
    assert.match(
      ui.getScreen(),
      columns === 22 ? /› \[ Back \]/ : /› \[ Back to providers \]/,
    );
    ui.events.keypress('down');
    assert.match(
      ui.getScreen(),
      columns === 22 ? /› \[ Review \]/ : /› \[ Review changes \]/,
    );
    assert.doesNotMatch(ui.getScreen(), /Review Repository|before applying/);
    for (const line of ui.getScreen().split('\n'))
      assert.ok(stringWidth(line) <= columns, line);
    assert.ok(ui.getScreen().split('\n').length <= 24);
    ui.events.keypress('enter');
    assert.deepEqual(await ui.answer, []);
  }
});

test('compact picker shows descriptions under every provider and kit, with responsive breadcrumbs', async () => {
  const first = externalKit('first', 'acme/skills');
  const second = externalKit('second', 'acme/skills');
  const third = externalKit('third', 'other/skills');
  for (const columns of [40, 80]) {
    const ui = await render(kitPicker, {
      catalog: {
        root: '/work/project',
        kits: new Map([
          [first.id, first],
          [second.id, second],
          [third.id, third],
        ]),
      },
      selected: [],
      columns,
      rows: columns === 40 ? 16 : 24,
    });
    assert.match(ui.getScreen(), /acme\/skills[^\n]*\n\s+Repository sources/);
    assert.match(ui.getScreen(), /other\/skills[^\n]*\n\s+Repository sources/);
    ui.events.keypress('enter');
    assert.match(ui.getScreen(), /○ first[^\n]*\n\s+Workflow for first/);
    assert.match(ui.getScreen(), /○ second[^\n]*\n\s+Workflow for second/);
    assert.match(ui.getScreen(), /Workflow for first/);
    assert.doesNotMatch(
      ui.getScreen(),
      /Destination:|Pending|\/work\/project|This repository only/,
    );
    assert.match(
      ui.getScreen(),
      columns === 80
        ? /\[Browse › acme\/skills\]/
        : /\[Browse\][^\n]*\n\s+acme\/skills/,
    );
    ui.events.keypress('down');
    assert.match(ui.getScreen(), /Workflow for second/);
    assert.match(ui.getScreen(), /Workflow for first/);
    ui.events.keypress('space');
    assert.match(ui.getScreen(), /● second/);
    assert.doesNotMatch(ui.getScreen(), /● second[^\n]*selected/);
    assert.match(ui.getScreen(), /1 selected/);
    assert.match(ui.getScreen(), /Esc back/);
    ui.events.type('second');
    assert.match(ui.getScreen(), /Esc clear/);
    assert.doesNotMatch(ui.getScreen(), /Esc back/);
    for (const line of ui.getScreen().split('\n'))
      assert.ok(stringWidth(line) <= columns, line);
    assert.ok(ui.getScreen().split('\n').length <= (columns === 40 ? 16 : 24));
    continuePicker(ui);
    assert.deepEqual(await ui.answer, ['second']);
  }
});
