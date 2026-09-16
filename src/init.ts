import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exists, safePath } from './fs.js';
import { apply, planExcludes } from './storage.js';

export function initialize(
  cwd: string,
  global = fs.realpathSync(cwd) === fs.realpathSync(os.homedir()),
): void {
  const root = fs.realpathSync(cwd);
  const target = safePath(root, '.loadout');
  if (exists(target))
    throw new Error(
      '.loadout already exists. Refusing to replace an existing catalog.',
    );
  const exclude = planExcludes(root, []); // Validate before creating anything.
  try {
    const starterFiles: Record<string, string> = {
      'config.yaml': 'schemaVersion: 1\n',
    };
    if (!global) {
      starterFiles['kits/starter/kit.yaml'] = `schemaVersion: 1
id: starter
description: Add your repository guidance
ready: false
outputs:
  - type: skill
    source: skills/starter
`;
      starterFiles['kits/starter/skills/starter/SKILL.md'] = `---
name: starter
description: Replace this with when to use your repository skill.
---

# Starter

This is an unfinished template. It supplies no agent instructions.

Replace this text with your repository workflow, update the description,
and set ready: true in the kit's kit.yaml when it is ready to use.
`;
    }
    for (const [relative, content] of Object.entries(starterFiles)) {
      const file = path.join(target, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { flag: 'wx' });
    }
    apply({
      root,
      changes: [],
      exclude,
    });
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
