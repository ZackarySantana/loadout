import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '@inquirer/testing';
import stringWidth from 'string-width';
import { targetPicker } from '../src/picker.js';
import { type Kit } from '../src/schema.js';
import { type Target } from '../src/targets.js';

function targets(): Target[] {
  const kit = (id: string): Kit => ({
    schemaVersion: 1,
    id,
    description: `Configure ${id}`,
    origin: 'personal',
    questions: {},
    requires: [],
    outputs: [],
    directory: '.',
  });
  const kits = new Map(['alpha', 'beta'].map((id) => [id, kit(id)]));
  return [false, true].map((global) => ({
    label: global ? 'Global' : 'Repository',
    root: global ? '/home/example' : '/home/example/project',
    global,
    catalog: { root: '.', kits },
    state: { schemaVersion: 1, selected: [], answers: {} },
  }));
}

test('switching preserves each provider, editable filter, cursor, and pending selections in a compact terminal', async () => {
  const locations = targets();
  const ui = await render(targetPicker, {
    targets: locations,
    columns: 40,
    rows: 16,
  });
  const fits = () => {
    assert.ok(ui.getScreen().split('\n').length <= 16, ui.getScreen());
    for (const line of ui.getScreen().split('\n'))
      assert.ok(stringWidth(line) <= 40, line);
  };
  ui.events.keypress('enter');
  ui.events.type('beta');
  ui.events.keypress('space');
  ui.events.keypress('down');
  assert.match(ui.getScreen(), /› \[ Back to providers \]/);
  fits();
  ui.events.keypress('tab');
  assert.match(ui.getScreen(), /\[○ Repository[^\]]*\*\].*\[● Global\]/);
  assert.doesNotMatch(ui.getScreen(), /unapplied selections|\/home\/example/);
  assert.match(ui.getScreen(), /› ▸ Personal/); // Ready to browse immediately.
  assert.match(ui.getScreen(), /\[● Global\]/);
  assert.doesNotMatch(ui.getScreen(), /Switch to Global\?/);
  ui.events.keypress('enter');
  ui.events.type('alpha');
  ui.events.keypress('space');
  ui.events.keypress('down');
  assert.match(ui.getScreen(), /\[○ Repository[^\]]*\*\].*\[● Global\*\]/);
  assert.doesNotMatch(ui.getScreen(), /Pending:|unapplied selections/);
  fits();
  ui.events.keypress('tab');
  fits();
  assert.match(ui.getScreen(), /Personal/);
  assert.match(ui.getScreen(), /\/ beta/);
  assert.match(ui.getScreen(), /● beta/);
  assert.match(ui.getScreen(), /› \[ Back to providers \]/);
  ui.events.type('x');
  assert.match(ui.getScreen(), /\/ betax/);
  assert.match(ui.getScreen(), /No matching kits/);
  ui.events.keypress('tab');
  assert.match(ui.getScreen(), /\/ alpha/);
  assert.match(ui.getScreen(), /› \[ Back to providers \]/);
  ui.events.keypress('escape'); // Acts on the restored filter immediately.
  assert.match(ui.getScreen(), /Search kits/);
  assert.doesNotMatch(ui.getScreen(), /\/ alpha/);
  assert.match(ui.getScreen(), /\[● Global\*\]/);
  ui.events.keypress('tab');
  assert.match(ui.getScreen(), /\/ betax/);
  assert.match(ui.getScreen(), /No matching kits/);
  ui.events.keypress('backspace');
  assert.match(ui.getScreen(), /\/ beta/);
  ui.events.keypress('up'); // Review wraps from the first kit.
  assert.doesNotMatch(ui.getScreen(), /Review Repository|before applying/);
  ui.events.keypress('enter');
  assert.deepEqual(
    (await ui.answer).map(({ state }) => state.selected),
    [['beta'], ['alpha']],
  );
  assert.deepEqual(
    locations.map(({ state }) => state!.selected),
    [[], []],
  );
});

test('Tab and Shift+Tab switch immediately while arrows still navigate the restored section', async () => {
  const ui = await render(targetPicker, { targets: targets() });
  ui.events.keypress('right');
  assert.match(ui.getScreen(), /\[Installed\]/);
  ui.events.keypress('tab');
  assert.match(ui.getScreen(), /\[● Global\]/);
  assert.match(ui.getScreen(), /\[Browse\]/);
  ui.events.keypress('right');
  assert.match(ui.getScreen(), /\[● Global\]/);
  assert.match(ui.getScreen(), /\[Installed\]/);
  ui.events.keypress('left');
  ui.events.keypress({ name: 'tab', shift: true });
  assert.match(ui.getScreen(), /\[● Repository[^\]]*\]/);
  assert.match(ui.getScreen(), /\[Installed\]/);
  assert.match(ui.getScreen(), /› \[ Review changes \]/);
  ui.events.keypress('enter');
  assert.deepEqual((await ui.answer)[0]!.state.selected, []);
});

test('scope colors follow provider arrows, kit markers, search, tabs, and action focus', async (t) => {
  const color = process.env.FORCE_COLOR;
  const noColor = process.env.NO_COLOR;
  t.after(() => {
    if (color === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = color;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  });
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';
  const ui = await render(targetPicker, {
    targets: targets(),
    columns: 100,
    rows: 30,
  });
  assert.match(
    ui.getScreen({ raw: true }),
    /\u001b\[36m\[● Repository · project\]/,
  );
  assert.match(ui.getScreen({ raw: true }), /\u001b\[35m\[○ Global\]/);
  assert.match(ui.getScreen({ raw: true }), /\u001b\[36m›/);
  assert.match(ui.getScreen({ raw: true }), /\u001b\[36m▸/);
  assert.doesNotMatch(ui.getScreen(), /This repository only|\/home\/example/);
  ui.events.keypress('tab');
  assert.match(ui.getScreen({ raw: true }), /\u001b\[35m\[● Global\]/);
  assert.match(ui.getScreen({ raw: true }), /\u001b\[35m›/);
  assert.match(ui.getScreen({ raw: true }), /\u001b\[35m▸/);
  assert.match(ui.getScreen({ raw: true }), /\u001b\[35m\u001b\[1m\[Browse\]/);
  assert.match(ui.getScreen({ raw: true }), /\u001b\[35m\//);
  assert.doesNotMatch(
    ui.getScreen(),
    /For your user across repositories|\/home\/example/,
  );
  ui.events.keypress('enter');
  assert.match(ui.getScreen({ raw: true }), /\u001b\[35m○/);
  ui.events.keypress('space');
  assert.match(ui.getScreen({ raw: true }), /\u001b\[35m●/);
  ui.events.keypress('up');
  assert.match(
    ui.getScreen({ raw: true }),
    /\u001b\[35m\u001b\[1m\[ Review changes \]/,
  );
  ui.events.keypress({ name: 'tab', shift: true });
  assert.doesNotMatch(ui.getScreen(), /This repository only|\/home\/example/);
  assert.match(ui.getScreen({ raw: true }), /\u001b\[36m›/);
  ui.events.keypress('up');
  ui.events.keypress('enter');
  await ui.answer;
});

test('Back helper stays beside its button and footer positions stay fixed across focus and scope switches', async () => {
  for (const columns of [40, 80]) {
    const ui = await render(targetPicker, {
      targets: targets(),
      columns,
      rows: columns === 40 ? 16 : 24,
    });
    ui.events.keypress('enter');
    const footer = () =>
      ui
        .getScreen()
        .split('\n')
        .findIndex((line) => line.includes('[ Back to providers ]'));
    const position = footer();
    const lineCount = ui.getScreen().split('\n').length;
    for (let i = 0; i < 4; i++) {
      ui.events.keypress('down');
      assert.equal(footer(), position);
      assert.equal(ui.getScreen().split('\n').length, lineCount);
    }
    const helper = ui
      .getScreen()
      .split('\n')
      .filter((line) => line.includes('Keeps'));
    assert.equal(helper.length, 1);
    assert.match(helper[0]!, /\[ Back to providers \].*Keeps/);
    ui.events.keypress('tab');
    ui.events.keypress('enter');
    const globalPosition = footer();
    const globalLines = ui.getScreen().split('\n').length;
    ui.events.keypress('tab');
    assert.equal(footer(), position);
    assert.equal(ui.getScreen().split('\n').length, lineCount);
    ui.events.keypress('down');
    assert.equal(footer(), position);
    ui.events.keypress('tab');
    assert.equal(footer(), globalPosition);
    assert.equal(ui.getScreen().split('\n').length, globalLines);
    assert.doesNotMatch(
      ui.getScreen(),
      /unapplied selections|\/home\/example|For your user/,
    );
    for (const line of ui.getScreen().split('\n'))
      assert.ok(stringWidth(line) <= columns, line);
    ui.events.keypress('up');
    ui.events.keypress('enter');
    await ui.answer;
  }
});

test('a single destination remains visible without offering a scope switch', async () => {
  for (const location of targets()) {
    const ui = await render(targetPicker, { targets: [location] });
    assert.ok(ui.getScreen().includes(`[● ${location.label}`));
    assert.doesNotMatch(ui.getScreen(), /\[○ |Tab switch scope/);
    ui.events.type('alpha');
    const before = ui.getScreen();
    ui.events.keypress('tab');
    ui.events.keypress({ name: 'tab', shift: true });
    assert.equal(ui.getScreen(), before);
    ui.events.keypress('up');
    ui.events.keypress('enter');
    assert.deepEqual((await ui.answer)[0]!.state.selected, []);
  }
});
