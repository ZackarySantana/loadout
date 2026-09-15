import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// Expand paths ourselves: Windows shells do not expand the test glob.
const files = fs
  .readdirSync('test')
  .filter((file) => file.endsWith('.test.ts'))
  .sort()
  .map((file) => `test/${file}`);
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...process.argv.slice(2), ...files],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
