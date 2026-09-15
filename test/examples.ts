import fs from 'node:fs';
import path from 'node:path';
import { initialize as initializeStarter } from '../src/init.js';
import { fileURLToPath } from 'node:url';

export function installExamples(root: string): void {
  fs.cpSync(
    fileURLToPath(new URL('./fixtures/kits/', import.meta.url)),
    path.join(root, '.loadout/kits'),
    { recursive: true },
  );
}
export function initialize(root: string, global = false): void {
  initializeStarter(root, global);
  if (global) return;
  fs.rmSync(path.join(root, '.loadout/kits'), { recursive: true });
  installExamples(root);
}
