import { fileURLToPath } from 'node:url';

// Shared by source runs and the published dist/ entry point.
export const bundledRoot = fileURLToPath(new URL('../kits/', import.meta.url));

const agentCliKits = new Set([
  'loadout-claude-cli',
  'loadout-codex-cli',
  'loadout-opencode-cli',
]);

export function bundledProvider(id: string): string {
  return agentCliKits.has(id) ? 'loadout-agent-clis' : 'loadout';
}
