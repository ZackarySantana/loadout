import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

fs.rmSync('dist', { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc'],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
