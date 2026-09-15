import fs from 'node:fs';
import path from 'node:path';

export function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
// Reject symlinks on every existing component, including dangling links.
export function safePath(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  const local = path.relative(root, absolute);
  if (
    !local ||
    local === '..' ||
    local.startsWith(`..${path.sep}`) ||
    path.isAbsolute(local)
  )
    throw new Error(`Path escapes its permitted root: ${relative}`);
  let current = root;
  for (const component of local.split(path.sep)) {
    current = path.join(current, component);
    if (exists(current) && fs.lstatSync(current).isSymbolicLink())
      throw new Error(`Symlinks are not supported: ${current}`);
  }
  return absolute;
}
export function readOptional(
  root: string,
  relative: string,
): Buffer | undefined {
  const file = safePath(root, relative);
  if (!exists(file)) return undefined;
  if (!fs.statSync(file).isFile())
    throw new Error(`Expected a regular file: ${relative}`);
  return fs.readFileSync(file);
}
export function walk(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root).sort()) {
    const file = safePath(root, entry);
    const stat = fs.statSync(file);
    if (stat.isDirectory())
      files.push(...walk(file).map((p) => `${entry}/${p}`));
    else if (stat.isFile()) files.push(entry);
    else throw new Error(`Unsupported file type: ${file}`);
  }
  return files;
}
export function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

// Windows does not preserve POSIX executable/permission bits. Compare its
// generated files by content and use one stable mode in ownership metadata.
export function portableMode(mode: number): number {
  return process.platform === 'win32' ? 0o644 : mode & 0o777;
}
