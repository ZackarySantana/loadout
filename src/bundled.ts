import { fileURLToPath } from 'node:url';

// Shared by source runs and the published dist/ entry point.
export const bundledRoot = fileURLToPath(new URL('../kits/', import.meta.url));

export const bundledProviders: Readonly<
  Record<string, { description: string; prefix: string }>
> = {
  loadout: { description: 'Included with Loadout', prefix: 'loadout-' },
  'loadout-agent-clis': {
    description: 'Delegate tasks through agent CLI harnesses',
    prefix: 'loadout-',
  },
};
