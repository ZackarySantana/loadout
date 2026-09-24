import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { loadCatalog } from './catalog.js';
import { prepareAdoption } from './adoption.js';
import { json, portableMode, readOptional } from './fs.js';
import {
  catalogForUpdates,
  readExternal,
  renderWithExternal,
} from './external.js';
import {
  loadGenerated,
  loadState,
  plan,
  type Change,
  type Plan,
} from './storage.js';
import { parse, generatedSchema, type Generated } from './schema.js';
import { loadTarget } from './targets.js';
import { type PreparedTarget, type ReviewTarget } from './review.js';

const registryFile = '.loadout-personal/repositories.json';
const registrySchema = z
  .object({
    schemaVersion: z.literal(1),
    repositories: z.array(
      z.string().refine(path.isAbsolute, 'Use an absolute repository path'),
    ),
  })
  .strict();
type RenderOptions = NonNullable<Parameters<typeof renderWithExternal>[2]>;

function fileChange(root: string, file: string): Change {
  const bytes = readOptional(root, file);
  const before =
    bytes === undefined
      ? undefined
      : {
          content: bytes,
          mode: portableMode(fs.statSync(path.join(root, file)).mode),
        };
  return {
    path: file,
    before,
    after: before,
    kind: 'unchanged',
  };
}

async function globalOutputs(
  home: string,
  generated: Generated,
  guards: Map<string, Change>,
) {
  let outputs = generated.outputs;
  if (!outputs && Object.keys(generated.installedAt).length) {
    const catalog = loadCatalog(home, true);
    const rendered = await renderWithExternal(catalog, loadState(catalog), {
      offline: true,
    });
    const composed = prepareAdoption(
      home,
      rendered,
      generated.files,
      true,
      false,
    ).files;
    outputs = rendered.outputs?.filter((output) =>
      output.paths.every((file) => {
        const value = composed.get(file);
        return (
          value &&
          generated.files[file]?.hash ===
            createHash('sha256').update(value.content).digest('hex')
        );
      }),
    );
  }
  return (outputs ?? []).filter((output) =>
    output.paths.every((file) => {
      const owned = generated.files[file];
      if (!guards.has(file)) guards.set(file, fileChange(home, file));
      const value = guards.get(file)!.before;
      return (
        value &&
        owned &&
        owned.hash ===
          createHash('sha256').update(value.content).digest('hex') &&
        owned.mode === value.mode
      );
    }),
  );
}

// Every affected repository and the global installation share one preview/transaction.
// Repository selections and snapshots survive inheritance, including their answers.
export async function prepareInstallations(
  selections: ReviewTarget[],
  options: {
    adopt?: boolean;
    home?: string;
    signal?: AbortSignal;
    knownRoots?: string[];
    render?: (selection: ReviewTarget, index: number) => RenderOptions;
    ready?: (index: number) => void;
  } = {},
): Promise<PreparedTarget[]> {
  if (!selections.length) return [];
  options.signal?.throwIfAborted();
  const globalSelection = selections.find(({ target }) => target.global);
  const home = fs.realpathSync(
    globalSelection?.target.root ?? options.home ?? os.homedir(),
  );
  const registryChange = fileChange(home, registryFile);
  const raw = registryChange.before?.content;
  const registry = raw
    ? parse(registrySchema, JSON.parse(raw.toString()), registryFile)
    : { schemaVersion: 1 as const, repositories: [] };
  // Reconcile registered and explicitly known projects without scanning home.
  const roots = new Set(registry.repositories);
  for (const root of options.knownRoots ?? [])
    if (
      root !== home &&
      fs.existsSync(path.join(root, '.loadout-personal/local.json'))
    )
      roots.add(fs.realpathSync(root));
  for (const { target } of selections)
    if (!target.global) roots.add(fs.realpathSync(target.root));
  const expanded = [...selections];
  const prepared = new Map<ReviewTarget, PreparedTarget>();
  const globalOptions = globalSelection
    ? (options.render?.(globalSelection, selections.indexOf(globalSelection)) ??
      {})
    : {};
  let inherited: Set<string>;
  const guards = new Map(
    [
      '.loadout-personal/generated.json',
      '.loadout-personal/local.json',
      '.loadout-personal/external.json',
    ].map((file) => [file, fileChange(home, file)]),
  );
  const generatedBytes = guards.get('.loadout-personal/generated.json')!.before
    ?.content;
  const previousGlobal = generatedBytes
    ? parse(
        generatedSchema,
        JSON.parse(generatedBytes.toString()),
        'Global installation',
      )
    : { schemaVersion: 1 as const, installedAt: {}, files: {} };
  let snapshots = Object.values(readExternal(home).store.kits);
  if (globalSelection) {
    const { target, state, update } = globalSelection;
    const rendered = await renderWithExternal(target.catalog!, state, {
      ...globalOptions,
      update,
      signal: options.signal ?? globalOptions.signal,
    });
    const result = plan(
      catalogForUpdates(target.catalog!, update),
      state,
      rendered,
      { adopt: options.adopt },
    );
    prepared.set(globalSelection, { ...globalSelection, plan: result });
    const generated = parse(
      generatedSchema,
      JSON.parse(
        result.changes
          .find((change) => change.path === '.loadout-personal/generated.json')!
          .after!.content.toString(),
      ),
      'Global outputs',
    );
    inherited = new Set(generated.outputs?.map((output) => output.key));
    if (rendered.external)
      snapshots = Object.values(
        (
          JSON.parse(rendered.external.content.toString()) as ReturnType<
            typeof readExternal
          >['store']
        ).kits,
      );
    options.ready?.(selections.indexOf(globalSelection));
  } else {
    const outputs = await globalOutputs(home, previousGlobal, guards);
    inherited = new Set(outputs.map((output) => output.key));
  }
  if (globalSelection) {
    const globalIds = new Set([
      ...Object.keys(previousGlobal.installedAt),
      ...globalSelection.state.selected,
      ...(prepared.get(globalSelection)!.plan.installing ?? []),
    ]);
    for (const root of [...roots].sort()) {
      options.signal?.throwIfAborted();
      if (root === home || expanded.some(({ target }) => target.root === root))
        continue;
      if (!fs.existsSync(path.join(root, '.loadout-personal/local.json'))) {
        roots.delete(root);
        continue;
      }
      const generated = loadGenerated(root);
      const affected =
        generated.inherited?.length ||
        generated.outputs?.some((output) => inherited.has(output.key)) ||
        (!generated.outputs &&
          Object.keys(generated.installedAt).some((id) => globalIds.has(id)));
      if (!affected) continue;
      const target = loadTarget(root, false);
      if (!target.catalog || !target.state)
        throw new Error(
          `${root}: ${target.error ?? 'Cannot load repository installation'}`,
        );
      expanded.push({ target, state: target.state, update: [] });
    }
  }
  for (const selection of expanded) {
    options.signal?.throwIfAborted();
    if (selection === globalSelection) continue;
    const index = selections.indexOf(selection);
    const renderOptions: RenderOptions =
      index < 0
        ? { offline: true }
        : (options.render?.(selection, index) ?? {});
    const { target, state, update } = selection;
    const rendered = await renderWithExternal(target.catalog!, state, {
      ...renderOptions,
      update,
      inherited,
      snapshots,
      signal: options.signal ?? renderOptions.signal,
    });
    renderOptions.signal?.throwIfAborted();
    prepared.set(selection, {
      ...selection,
      plan: plan(catalogForUpdates(target.catalog!, update), state, rendered, {
        adopt: index < 0 ? false : options.adopt,
      }),
    });
    if (index >= 0) options.ready?.(index);
  }
  registry.repositories = [...roots].sort();
  const registryBytes = json(registry);
  registryChange.after = {
    content: registryBytes,
    mode: registryChange.before?.mode ?? 0o644,
  };
  registryChange.kind = registryChange.before?.content.equals(registryBytes)
    ? 'unchanged'
    : registryChange.before
      ? 'update'
      : 'create';
  if (globalSelection) {
    prepared.get(globalSelection)!.plan.changes.push(registryChange);
  } else {
    const coordination: Plan = {
      root: home,
      metadataOnly: true,
      changes: [registryChange, ...guards.values()],
    };
    prepared.get(selections[0]!)!.plan.related = [coordination];
  }
  options.signal?.throwIfAborted();
  return expanded.map((selection) => prepared.get(selection)!);
}
