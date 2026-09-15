import { loadCatalog } from './catalog.js';
import { readExternal } from './external.js';
import { exists, safePath } from './fs.js';
import { initialize } from './init.js';
import { loadState } from './storage.js';
import { type Catalog, type State } from './schema.js';

export type Target = {
  label: string;
  root: string;
  global: boolean;
  catalog?: Catalog;
  state?: State;
  error?: string;
};

export function loadTarget(root: string, global: boolean): Target {
  const target: Target = {
    root,
    global,
    label: global ? 'Global' : 'Repository',
  };
  try {
    if (!exists(safePath(root, '.loadout/config.yaml'))) return target;
    const catalog = loadCatalog(root, global);
    const { store } = readExternal(root);
    for (const [id, snapshot] of Object.entries(store.kits)) {
      const kit = catalog.kits.get(id);
      if (kit?.external) kit.pinned = snapshot.source;
    }
    return { ...target, catalog, state: loadState(catalog) };
  } catch (error) {
    return { ...target, error: (error as Error).message };
  }
}

export function initializeTarget(target: Target): Target {
  initialize(target.root, target.global);
  return loadTarget(target.root, target.global);
}
