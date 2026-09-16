import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export type IgnoreTarget = {
  root: string;
  key: string;
  prefix: string;
};

// Git resolves the common metadata directory for linked worktrees and repos
// whose .git is a file. Exclude patterns are relative to the working-tree root.
export function ignoreTarget(root: string): IgnoreTarget | undefined {
  try {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, 'rev-parse', ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).replace(/\r?\n$/, '');
    const topPath = git('--show-toplevel');
    const exclude = git('--path-format=absolute', '--git-path', 'info/exclude');
    if (!path.isAbsolute(topPath) || !path.isAbsolute(exclude))
      throw new Error('Git returned a non-absolute repository path.');
    const top = fs.realpathSync(topPath);
    const prefix = path.relative(top, root).split(path.sep).join('/');
    if (/[\r\n]/.test(prefix))
      throw new Error('Catalog paths containing newlines cannot be ignored.');
    return {
      root: fs.realpathSync(path.resolve(exclude, '../..')),
      key: createHash('sha256').update(root).digest('hex').slice(0, 16),
      prefix: prefix ? `${prefix}/` : '',
    };
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: Buffer };
    if (
      (e.code === 'ENOENT' && e.syscall?.startsWith('spawn')) ||
      e.stderr?.toString().includes('not a git repository')
    )
      return undefined;
    throw new Error(`Cannot resolve local Git excludes: ${e.message}`);
  }
}

export function ignoredText(
  original: string,
  target: IgnoreTarget,
  paths: string[],
): string {
  const start = `# >>> loadout ${target.key}`;
  const end = `# <<< loadout ${target.key}`;
  const lines = original.split(/(?<=\n)/);
  const markers = lines.map((line) => line.replace(/\r?\n$/, ''));
  const first = markers.indexOf(start),
    last = markers.indexOf(end);
  if (
    first < 0 !== last < 0 ||
    last < first ||
    markers.filter((line) => line === start).length > 1 ||
    markers.filter((line) => line === end).length > 1
  )
    throw new Error(
      'Malformed Loadout block in Git info/exclude; repair its markers before applying.',
    );
  const escape = (p: string) => p.replace(/[\\*?\[\]#! ]/g, '\\$&');
  const patterns = [...new Set(['.loadout-personal/', ...paths])]
    .sort()
    .map((p) => `/${escape(target.prefix + p)}`);
  const block = `${start}\n${patterns.join('\n')}\n${end}\n`;
  if (first >= 0) {
    lines.splice(first, last - first + 1, block);
    return lines.join('');
  }
  return `${original}${original && !original.endsWith('\n') ? '\n' : ''}${block}`;
}
