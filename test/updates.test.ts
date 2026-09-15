import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '@inquirer/testing';
import { selectUpdates } from '../src/interactive.js';
import { availableUpdates, hasUpdate } from '../src/updates.js';
import { type Kit, type Catalog, type State } from '../src/schema.js';

const source = {
  repo: 'acme/skills',
  ref: '1'.repeat(40),
  skills: ['skills/alpha'],
  license: 'LICENSE',
};
const remote: Kit = {
  schemaVersion: 1,
  id: 'remote',
  description: 'Remote',
  directory: '.',
  requires: [],
  questions: {},
  outputs: [],
  pinned: source,
  external: { ...source, ref: '2'.repeat(40) },
};
const local: Kit = {
  schemaVersion: 1,
  id: 'local',
  description: 'Local',
  directory: '.',
  requires: ['remote'],
  questions: {},
  outputs: [],
};
const catalog: Catalog = {
  root: '.',
  kits: new Map([
    ['local', local],
    ['remote', remote],
  ]),
};
const state: State = { schemaVersion: 1, selected: ['local'], answers: {} };

test('updates include dependencies, exclude uninstalled kits, and compare semantic source identity', () => {
  assert.deepEqual(
    availableUpdates(catalog, state.selected).map((kit) => kit.id),
    ['remote'],
  );
  assert.equal(availableUpdates(catalog, []).length, 0);
  assert.equal(availableUpdates(catalog).length, 1);
  assert.equal(hasUpdate({ ...remote, pinned: undefined }), false);
  assert.equal(hasUpdate({ ...remote, external: { ...source } }), false);
  assert.equal(
    hasUpdate({
      ...remote,
      pinned: { ...source, skills: ['skills/a', 'skills/b'] },
      external: { ...source, skills: ['skills/b', 'skills/a'] },
    }),
    false,
  );
  assert.equal(
    hasUpdate({ ...remote, external: { ...source, license: 'COPYING' } }),
    true,
  );
});

test('interactive updates require a selection and support skipping, accepting, and offline reuse', async () => {
  const prompt = (
    _config: object,
    context?: Parameters<typeof selectUpdates>[3],
  ) => selectUpdates(catalog, state, false, context);
  const skipped = await render(prompt, {});
  assert.match(skipped.getScreen(), /Catalog updates available/);
  assert.match(skipped.getScreen(), /111111111111 → acme\/skills@222222222222/);
  skipped.events.keypress('enter');
  assert.deepEqual(await skipped.answer, []);
  const accepted = await render(prompt, {});
  accepted.events.keypress('space');
  accepted.events.keypress('enter');
  assert.deepEqual(await accepted.answer, ['remote']);
  assert.deepEqual(await selectUpdates(catalog, state, true), []);
  assert.deepEqual(
    await selectUpdates(catalog, { ...state, selected: [] }),
    [],
  );
});
