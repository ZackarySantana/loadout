import { loadCatalog } from './catalog.js';
import { readExternal } from './external.js';
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
    const catalog = loadCatalog(root, global);
    const { store } = readExternal(catalog.root);
    for (const [id, snapshot] of Object.entries(store.kits)) {
      const kit = catalog.kits.get(id);
      if (kit?.external) kit.pinned = snapshot.source;
    }
    return { ...target, catalog, state: loadState(catalog) };
  } catch (error) {
    return { ...target, error: (error as Error).message };
  }
}
