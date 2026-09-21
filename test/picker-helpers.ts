import assert from 'node:assert/strict';
import { type render } from '@inquirer/testing';

type Screen = Pick<Awaited<ReturnType<typeof render>>, 'events' | 'getScreen'>;

export function continuePicker(
  ui: Screen,
  key: 'space' | 'enter' = 'enter',
): void {
  // Return to Browse's provider list, then focus its final button.
  for (
    let steps = 0;
    steps < 4 && !ui.getScreen().includes('[Installed]');
    steps++
  )
    ui.events.keypress('right');
  assert.match(ui.getScreen(), /\[Installed\]/);
  ui.events.keypress('left');
  ui.events.keypress('up');
  assert.match(ui.getScreen(), /› \[ Review changes \]/);
  ui.events.keypress(key);
}
