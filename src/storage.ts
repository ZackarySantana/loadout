import fs from 'node:fs';
import { isOutput } from './output-path.js';
import { prepareAdoption } from './adoption.js';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  exists,
  json,
  readOptional,
  safePath,
  walk,
  portableMode,
} from './fs.js';
import {
  parse,
  ownedSchema,
  stateSchema,
  type Catalog,
  type State,
} from './schema.js';
import { type FileContent, type Rendered } from './render.js';

const start = '# >>> loadout';
const end = '# <<< loadout';
export type Change = {
  path: string;
  before?: FileContent;
  after?: FileContent;
  kind: 'create' | 'update' | 'delete' | 'unchanged';
};
export type Plan = {
  root: string;
  changes: Change[];
  adopted?: string[];
  guard?: {
    untracked: string[];
    directories: { path: string; files: string[] }[];
  };
};
const hash = (content: Buffer) =>
  createHash('sha256').update(content).digest('hex');
export function loadState(catalog: Catalog): State {
  const raw = readOptional(catalog.root, '.loadout/local.json');
  return raw
    ? parse(stateSchema, JSON.parse(raw.toString()), '.loadout/local.json')
    : { schemaVersion: 1, selected: [], answers: {} };
}
function snapshot(root: string, relative: string): FileContent | undefined {
  const content = readOptional(root, relative);
  return content === undefined
    ? undefined
    : {
        content,
        mode: portableMode(fs.statSync(safePath(root, relative)).mode),
      };
}
function equal(a?: FileContent, b?: FileContent): boolean {
  return a === undefined || b === undefined
    ? a === b
    : a.mode === b.mode && a.content.equals(b.content);
}
export function ignoredText(original: string, paths: string[]): string {
  const lines = original.split(/\r?\n/);
  const first = lines.indexOf(start),
    last = lines.indexOf(end);
  if (
    first < 0 !== last < 0 ||
    last < first ||
    lines.filter((l) => l === start).length > 1 ||
    lines.filter((l) => l === end).length > 1
  )
    throw new Error(
      'Malformed Loadout block in .gitignore; repair its markers before applying.',
    );
  if (first >= 0) lines.splice(first, last - first + 1);
  const base = lines.join('\n').replace(/\n*$/, '');
  // Escape gitignore metacharacters so these patterns own only exact paths.
  const escape = (p: string) => p.replace(/[\\*?\[\]#! ]/g, '\\$&');
  return `${base ? `${base}\n\n` : ''}${start}\n${[
    ...new Set([
      '.loadout/local.json',
      '.loadout/generated.json',
      '.loadout/external.json',
      '.loadout/adopted.json',
      '.loadout/adopted/',
      '.loadout/apply.lock/',
      ...paths,
    ]),
  ]
    .sort()
    .map((p) => `/${escape(p)}`)
    .join('\n')}\n${end}\n`;
}
function trackedFiles(root: string): Set<string> {
  try {
    return new Set(
      execFileSync('git', ['-C', root, 'ls-files', '-z'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .split('\0')
        .filter(Boolean),
    );
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: Buffer };
    if (
      e.code === 'ENOENT' ||
      e.stderr?.toString().includes('not a git repository')
    )
      return new Set();
    throw new Error(`Cannot check Git-tracked files: ${e.message}`);
  }
}
export function plan(
  catalog: Catalog,
  state: State,
  rendered: Rendered,
  options: { adopt?: boolean } = {},
): Plan {
  const root = catalog.root;
  const raw = readOptional(root, '.loadout/generated.json');
  const owned = raw
    ? parse(ownedSchema, JSON.parse(raw.toString()), '.loadout/generated.json')
        .files
    : {};
  const adoption = prepareAdoption(
    root,
    rendered,
    owned,
    !!catalog.global,
    !!options.adopt,
  );
  rendered = { ...rendered, files: adoption.files };
  const paths = [
    ...new Set([...Object.keys(owned), ...rendered.files.keys()]),
  ].sort();
  const tracked = trackedFiles(root);
  for (const local of [
    '.loadout/local.json',
    '.loadout/generated.json',
    '.loadout/external.json',
    '.loadout/adopted.json',
    ...adoption.beforeOutputs.map((change) => change.path),
    ...adoption.afterOutputs.map((change) => change.path),
  ])
    if (tracked.has(local))
      throw new Error(
        `${local} is tracked by Git. Untrack personal state before applying.`,
      );
  const changes: Change[] = [...adoption.beforeOutputs];
  for (const relative of paths) {
    if (!isOutput(relative, catalog.global))
      throw new Error(`Invalid generated ownership path: ${relative}`);
    if (tracked.has(relative))
      throw new Error(
        `Refusing to manage Git-tracked file: ${relative}. Move its content into a kit and untrack it first.`,
      );
    const before = snapshot(root, relative),
      after = rendered.files.get(relative),
      previous = owned[relative];
    if (
      before &&
      !previous &&
      adoption.adopted.includes(relative) &&
      !equal(before, adoption.originals.get(relative))
    )
      throw new Error(`File changed while preparing adoption: ${relative}`);
    if (before && !previous && !adoption.adopted.includes(relative))
      throw new Error(
        `Unmanaged file already exists: ${relative}. Run loadout to preserve existing content, or preview with --adopt --dry-run.`,
      );
    if (
      before &&
      previous &&
      (hash(before.content) !== previous.hash || before.mode !== previous.mode)
    )
      throw new Error(
        `Generated file was manually modified: ${relative}. Move your edits into a kit, then restore or remove the generated file before applying.`,
      );
    changes.push({
      path: relative,
      before,
      after,
      kind: equal(before, after)
        ? 'unchanged'
        : !before
          ? 'create'
          : !after
            ? 'delete'
            : 'update',
    });
  }
  for (const skill of rendered.skillRoots) {
    if (
      exists(safePath(root, skill)) &&
      ![...Object.keys(owned), ...adoption.adopted].some((p) =>
        p.startsWith(`${skill}/`),
      )
    )
      throw new Error(`Unmanaged skill directory already exists: ${skill}`);
  }
  const files = Object.fromEntries(
    [...rendered.files]
      .filter(([p]) => !adoption.released.has(p))
      .map(([p, f]) => [p, { hash: hash(f.content), mode: f.mode }]),
  );
  const metadata = new Map<string, Buffer>([
    ['.loadout/local.json', json(state)],
    ['.loadout/generated.json', json({ schemaVersion: 1, files })],
    [
      '.gitignore',
      Buffer.from(
        ignoredText(readOptional(root, '.gitignore')?.toString() ?? '', [
          ...Object.keys(files),
        ]),
      ),
    ],
  ]);
  if (rendered.external) {
    const current = readOptional(root, '.loadout/external.json');
    if (
      current === undefined
        ? rendered.external.before !== undefined
        : !rendered.external.before?.equals(current)
    )
      throw new Error(
        'External snapshots changed while preparing the preview. Run the command again.',
      );
    metadata.set('.loadout/external.json', rendered.external.content);
  }
  changes.push(...adoption.afterOutputs);
  for (const [relative, content] of metadata) {
    const before = snapshot(root, relative),
      after = { content, mode: before?.mode ?? 0o644 };
    changes.push({
      path: relative,
      before,
      after,
      kind: equal(before, after) ? 'unchanged' : before ? 'update' : 'create',
    });
  }
  return {
    root,
    changes,
    adopted: adoption.adopted,
    guard: {
      untracked: changes
        .filter((change) => change.path !== '.gitignore')
        .map((change) => change.path),
      directories: [...rendered.skillRoots]
        .filter((skill) =>
          adoption.adopted.some((file) => file.startsWith(`${skill}/`)),
        )
        .map((skill) => ({
          path: skill,
          files: [...rendered.files.keys()]
            .filter((file) => file.startsWith(`${skill}/`))
            .map((file) => file.slice(skill.length + 1))
            .sort(),
        })),
    },
  };
}
function writeAtomic(root: string, relative: string, file: FileContent): void {
  const target = safePath(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.loadout-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, file.content, { flag: 'wx', mode: file.mode });
    fs.chmodSync(temp, file.mode);
    fs.renameSync(temp, target);
  } finally {
    if (exists(temp)) fs.unlinkSync(temp);
  }
}
function prune(root: string, relative: string): void {
  // Repository scopes and agent configuration roots may predate Loadout.
  // Only prune empty skill directories and internal adoption backups.
  const boundary =
    /^(\.(?:agents|claude)\/skills)\//.exec(relative)?.[1] ??
    (relative.startsWith('.loadout/adopted/') ? '.loadout' : undefined);
  if (!boundary) return;
  const stop = safePath(root, boundary);
  let directory = path.dirname(safePath(root, relative));
  while (directory !== stop) {
    try {
      fs.rmdirSync(directory);
    } catch {
      break;
    }
    directory = path.dirname(directory);
  }
}
export function apply(plan: Plan): number {
  return applyAll([plan]);
}

export function applyAll(plans: Plan[]): number {
  if (new Set(plans.map((plan) => plan.root)).size !== plans.length)
    throw new Error('Cannot apply multiple plans for the same location.');
  const locks: string[] = [];
  const written: { root: string; change: Change }[] = [];
  try {
    for (const plan of [...plans].sort((a, b) =>
      a.root.localeCompare(b.root),
    )) {
      const lock = safePath(plan.root, '.loadout/apply.lock');
      try {
        fs.mkdirSync(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new Error(
            'Another apply is running (or a previous process stopped). Remove .loadout/apply.lock only after confirming no Loadout process is running.',
          );
        throw error;
      }
      locks.push(lock);
    }
    // Recheck every location before writing to any of them.
    for (const plan of plans) {
      if (!plan.guard) continue;
      const tracked = trackedFiles(plan.root);
      for (const file of plan.guard.untracked)
        if (tracked.has(file))
          throw new Error(`File became Git-tracked since preview: ${file}`);
      for (const directory of plan.guard.directories) {
        const current = walk(safePath(plan.root, directory.path)).sort();
        if (JSON.stringify(current) !== JSON.stringify(directory.files))
          throw new Error(
            `Skill directory changed since preview: ${directory.path}`,
          );
      }
    }
    for (const plan of plans)
      for (const change of plan.changes)
        if (!equal(snapshot(plan.root, change.path), change.before))
          throw new Error(
            `File changed since preview: ${change.path}. Run the command again.`,
          );
    for (const plan of plans) {
      for (const change of plan.changes) {
        if (change.kind === 'unchanged') continue;
        if (change.after) writeAtomic(plan.root, change.path, change.after);
        else fs.unlinkSync(safePath(plan.root, change.path));
        written.push({ root: plan.root, change });
      }
    }
  } catch (error) {
    const failures: string[] = [];
    for (const { root, change } of written.reverse()) {
      try {
        if (change.before) writeAtomic(root, change.path, change.before);
        else {
          fs.unlinkSync(safePath(root, change.path));
          prune(root, change.path);
        }
      } catch {
        failures.push(path.join(root, change.path));
      }
    }
    if (failures.length)
      throw new Error(
        `${(error as Error).message}; rollback failed for: ${failures.join(', ')}`,
      );
    throw error;
  } finally {
    for (const lock of locks.reverse()) fs.rmdirSync(lock);
  }
  for (const { root, change } of written)
    if (!change.after) prune(root, change.path);
  return written.length;
}
