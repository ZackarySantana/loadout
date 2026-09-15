import path from 'node:path';
import { scopeSchema } from './schema.js';

export function isOutput(relative: string, global = false): boolean {
  if (global && ['.codex/AGENTS.md', '.claude/CLAUDE.md'].includes(relative))
    return true;
  if (
    relative.includes('\\') ||
    relative.split('/').some((p) => !p || p === '.' || p === '..') ||
    /[\x00-\x1f]/.test(relative)
  )
    return false;
  if (/^\.(agents|claude)\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/.+/.test(relative))
    return true;
  const directory = path.posix.dirname(relative);
  return (
    ['AGENTS.md', 'CLAUDE.md'].includes(path.posix.basename(relative)) &&
    scopeSchema.safeParse(directory).success
  );
}
