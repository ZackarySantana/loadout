import fs from 'node:fs';
import { isOutput } from './output-path.js';
import { ignoredText, ignoreTarget, type IgnoreTarget } from './ignore.js';
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
  generatedSchema,
  stateSchema,
  type Catalog,
  type State,
  type Generated,
} from './schema.js';
import { type FileContent, type Rendered } from './render.js';
import { resolveKits } from './resolve.js';

export type Change = {
  path: string;
  before?: FileContent;
  after?: FileContent;
  kind: 'create' | 'update' | 'delete' | 'unchanged';
};
export type Plan = {
  root: string;
  changes: Change[];
  installing?: string[];
  inherited?: string[];
  related?: Plan[];
  metadataOnly?: boolean;
  adopted?: string[];
  skippedInstructions?: { paths: string[]; kits: string[]; reason: string }[];
  kitsWithoutOutputs?: string[];
  exclude?: ExcludePlan;
  guard?: {
    untracked: string[];
    directories: { path: string; files: string[] }[];
  };
};
const hash = (content: Buffer) =>
  createHash('sha256').update(content).digest('hex');
export function loadState(catalog: Catalog): State {
  const raw = readOptional(catalog.root, '.loadout-personal/local.json');
  return raw
    ? parse(
        stateSchema,
        JSON.parse(raw.toString()),
        '.loadout-personal/local.json',
      )
    : { schemaVersion: 1, selected: [], answers: {} };
}
export function loadGenerated(root: string): Generated {
  const raw = readOptional(root, '.loadout-personal/generated.json');
  return raw
    ? parse(
        generatedSchema,
        JSON.parse(raw.toString()),
        '.loadout-personal/generated.json',
      )
    : { schemaVersion: 1 as const, installedAt: {}, files: {} };
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
type ExcludePlan = {
  target: IgnoreTarget;
  paths: string[];
  change: Change;
};
export function planExcludes(
  root: string,
  paths: string[],
): ExcludePlan | undefined {
  const target = ignoreTarget(root);
  if (!target) return undefined;
  const before = snapshot(target.root, 'info/exclude');
  const after = {
    content: Buffer.from(
      ignoredText(before?.content.toString() ?? '', target, paths),
    ),
    mode: before?.mode ?? 0o644,
  };
  return {
    target,
    paths,
    change: {
      path: 'info/exclude',
      before,
      after,
      kind: equal(before, after) ? 'unchanged' : before ? 'update' : 'create',
    },
  };
}
export function hasChanges(plan: Plan): boolean {
  return (
    !!plan.related?.some(hasChanges) ||
    plan.changes.some((change) => change.kind !== 'unchanged') ||
    !!(plan.exclude && plan.exclude.change.kind !== 'unchanged')
  );
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
  const generated = loadGenerated(root);
  const owned = generated.files;
  const restoreAdoptions = new Set(generated.suspendedAdoptions ?? []);
  const enabled = resolveKits(catalog, state.selected).sort();
  const installing = enabled.filter(
    (id) => !Object.hasOwn(generated.installedAt, id),
  );
  const plannedAt = new Date().toISOString();
  const installedAt = Object.fromEntries(
    enabled.map((id) => [id, generated.installedAt[id] ?? plannedAt]),
  );
  const tracked = trackedFiles(root);
  const skippedInstructions: NonNullable<Plan['skippedInstructions']> = [];
  const retainedKits = new Set(rendered.skillKits);
  rendered = { ...rendered, files: new Map(rendered.files) };
  for (const group of rendered.instructionGroups) {
    // Existing ownership still requires the usual edit/deletion safeguards.
    const conflict = group.paths.some((file) => Object.hasOwn(owned, file))
      ? undefined
      : group.paths.find(
          (file) =>
            tracked.has(file) ||
            (!options.adopt &&
              !restoreAdoptions.has(file) &&
              exists(safePath(root, file))),
        );
    if (!conflict) {
      for (const id of group.kits) retainedKits.add(id);
      continue;
    }
    skippedInstructions.push({
      ...group,
      reason: tracked.has(conflict)
        ? `${conflict} is tracked by Git`
        : `${conflict} already exists and is not managed by Loadout`,
    });
    // CLAUDE.md imports AGENTS.md, so skip the whole scope together.
    for (const file of group.paths) rendered.files.delete(file);
  }
  const kitsWithoutOutputs = [
    ...new Set(skippedInstructions.flatMap((group) => group.kits)),
  ].filter((id) => !retainedKits.has(id));
  const adoption = prepareAdoption(
    root,
    rendered,
    owned,
    !!catalog.global,
    options.adopt ? true : restoreAdoptions,
  );
  rendered = { ...rendered, files: adoption.files };
  const paths = [
    ...new Set([...Object.keys(owned), ...rendered.files.keys()]),
  ].sort();
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
    ['.loadout-personal/local.json', json(state)],
    [
      '.loadout-personal/generated.json',
      json({
        schemaVersion: 1,
        installedAt,
        files,
        outputs: rendered.outputs?.filter((output) =>
          output.paths.every((file) => Object.hasOwn(files, file)),
        ),
        inherited: [...(rendered.inherited ?? [])].sort(),
        suspendedAdoptions: [
          ...new Set([...restoreAdoptions, ...adoption.released]),
        ]
          .filter((file) => rendered.inheritedPaths?.has(file))
          .sort(),
      }),
    ],
  ]);
  if (rendered.external) {
    const current = readOptional(root, '.loadout-personal/external.json');
    if (
      current === undefined
        ? rendered.external.before !== undefined
        : !rendered.external.before?.equals(current)
    )
      throw new Error(
        'External snapshots changed while preparing the preview. Run the command again.',
      );
    metadata.set('.loadout-personal/external.json', rendered.external.content);
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
  for (const change of changes)
    if (tracked.has(change.path))
      throw new Error(`Refusing to manage Git-tracked file: ${change.path}`);
  return {
    root,
    changes,
    installing,
    inherited: [...(rendered.inherited ?? [])].sort(),
    adopted: adoption.adopted,
    skippedInstructions,
    kitsWithoutOutputs,
    exclude: planExcludes(root, Object.keys(files)),
    guard: {
      untracked: changes.map((change) => change.path),
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
    (relative.startsWith('.loadout-personal/adopted/')
      ? '.loadout-personal'
      : undefined);
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
  const expand = (items: Plan[]): Plan[] =>
    items.flatMap((item) => [item, ...expand(item.related ?? [])]);
  plans = expand(plans);
  if (new Set(plans.map((plan) => plan.root)).size !== plans.length)
    throw new Error('Cannot apply multiple plans for the same location.');
  // Several catalogs/worktrees can share one excludes file. Merge their blocks
  // into one transactional write, retaining all other catalogs' rules.
  const excludes = new Map<string, Change>();
  for (const plan of plans) {
    if (!plan.exclude) continue;
    const { target, paths, change } = plan.exclude;
    const previous = excludes.get(target.root);
    if (!previous) {
      excludes.set(target.root, change);
      continue;
    }
    if (!equal(previous.before, change.before))
      throw new Error(
        'Git excludes changed between previews. Run the command again.',
      );
    const after = {
      ...change.after!,
      content: Buffer.from(
        ignoredText(previous.after!.content.toString(), target, paths),
      ),
    };
    excludes.set(target.root, {
      ...previous,
      after,
      kind: equal(previous.before, after)
        ? 'unchanged'
        : previous.before
          ? 'update'
          : 'create',
    });
  }
  const writes = [
    ...[...excludes].map(([root, change]) => ({ root, change })),
    ...plans.flatMap((plan) =>
      plan.changes.map((change) => ({
        root: plan.root,
        change,
      })),
    ),
  ];
  const locks: string[] = [];
  const written: { root: string; change: Change }[] = [];
  try {
    for (const plan of [...plans].sort((a, b) =>
      a.root.localeCompare(b.root),
    )) {
      const lock = safePath(plan.root, '.loadout-personal/apply.lock');
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      try {
        fs.mkdirSync(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new Error(
            `Another apply is running (or a previous process stopped). Remove ${lock} only after confirming no Loadout process is running.`,
          );
        throw error;
      }
      locks.push(lock);
    }
    // These locks also serialize applies from different linked worktrees.
    for (const root of [...excludes.keys()].sort()) {
      const lock = safePath(root, 'info/exclude.loadout.lock');
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      try {
        fs.mkdirSync(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new Error(
            `Another apply is using Git excludes (or a previous process stopped). Remove ${lock} only after confirming no Loadout process is running.`,
          );
        throw error;
      }
      locks.push(lock);
    }
    // Recheck every location before writing to any of them.
    for (const plan of plans) {
      if (plan.metadataOnly) continue;
      const current = ignoreTarget(plan.root);
      if (JSON.stringify(current) !== JSON.stringify(plan.exclude?.target))
        throw new Error(
          'Git exclude location changed since preview. Run the command again.',
        );
    }
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
    for (const { root, change } of writes)
      if (!equal(snapshot(root, change.path), change.before))
        throw new Error(
          `File changed since preview: ${change.path}. Run the command again.`,
        );
    const installedAt = new Date().toISOString();
    for (const { root, change: planned } of writes) {
      let change = planned;
      if (change.kind === 'unchanged') continue;
      const installing = plans.find((plan) => plan.root === root)?.installing;
      if (
        change.path === '.loadout-personal/generated.json' &&
        change.after &&
        installing?.length
      ) {
        const generated = parse(
          generatedSchema,
          JSON.parse(change.after.content.toString()),
          change.path,
        );
        for (const id of installing) generated.installedAt[id] = installedAt;
        change = {
          ...change,
          after: { ...change.after, content: json(generated) },
        };
      }
      if (change.after) writeAtomic(root, change.path, change.after);
      else fs.unlinkSync(safePath(root, change.path));
      written.push({ root, change });
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
