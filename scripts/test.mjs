import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Expand paths ourselves: Windows shells do not expand the test glob.
const files = fs
  .readdirSync('test')
  .filter((file) => file.endsWith('.test.ts'))
  .sort()
  .map((file) => `test/${file}`);
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-test-home-'));
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...process.argv.slice(2), ...files],
  {
    stdio: 'inherit',
    env: { ...process.env, HOME: testHome, USERPROFILE: testHome },
  },
);
fs.rmSync(testHome, { recursive: true, force: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
