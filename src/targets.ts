import { loadCatalog } from './catalog.js';
import { loadGenerated, loadState } from './storage.js';
import { type Catalog, type State } from './schema.js';

export type Target = {
  label: string;
  root: string;
  global: boolean;
  catalog?: Catalog;
  state?: State;
  installedAt?: Record<string, string>;
  inherited?: string[];
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
    const generated = loadGenerated(root);
    return {
      ...target,
      catalog,
      state: loadState(catalog),
      installedAt: generated.installedAt,
      inherited: generated.inherited,
    };
  } catch (error) {
    return { ...target, error: (error as Error).message };
  }
}
