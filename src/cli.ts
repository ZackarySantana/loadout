#!/usr/bin/env node
import { Command } from 'commander';
import { createTwoFilesPatch } from 'diff';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import os from 'node:os';
import { discover } from './catalog.js';
import { initialize } from './init.js';
import { interactive } from './setup.js';
import { apply, hasChanges, plan, type Plan } from './storage.js';
import {
  renderWithExternal,
  catalogForUpdates,
  hashSource,
  fetchBytes,
} from './external.js';
import { loadTarget, type Target } from './targets.js';
import {
  configure,
  disableKits,
  reasons,
  resolveKits,
  setAnswers,
} from './resolve.js';
import {
  kitSource,
  skillName,
  offeredSource,
  sourceVersion,
  catalogManifestSchema,
  parse,
  type Catalog,
  type State,
} from './schema.js';
import { availableUpdates, hasUpdate, updateDescription } from './updates.js';
import {
  refreshCatalogs,
  subscriptions,
  readCatalogCache,
} from './subscriptions.js';
import { editSubscription } from './catalog-config.js';

const version = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;
const program = new Command()
  .name('loadout')
  .description('Configure your repository’s agent tools.')
  .version(version)
  .option('-g, --global', 'enable kits for all repositories')
  .option('--offline', 'use saved external kits without network requests')
  .option(
    '-C, --cwd <directory>',
    'run in a different directory',
    process.cwd(),
  )
  .showHelpAfterError();
type Options = {
  answer?: string[];
  dryRun?: boolean;
  diff?: boolean;
  cascade?: boolean;
  update?: string[];
  adopt?: boolean;
};
function targetRoot(): { root: string; global: boolean } {
  const opts = program.opts<{ cwd: string; global?: boolean }>();
  const home = realpathSync(os.homedir());
  const root = opts.global ? home : discover(opts.cwd);
  return { root, global: root === home };
}
async function context(
  noNetwork = false,
): Promise<{ catalog: Catalog; state: State }> {
  const { root, global } = targetRoot();
  await refreshCatalogs(root, {
    global,
    offline: noNetwork || program.opts<{ offline?: boolean }>().offline,
    warn: (message) => console.error(`loadout: ${message}`),
  });
  const target = loadTarget(root, global);
  if (!target.catalog || !target.state)
    throw new Error(target.error ?? 'Cannot load kits for this location.');
  return { catalog: target.catalog, state: target.state };
}
async function interactiveTargets(): Promise<{
  targets: Target[];
  initial: number;
}> {
  const { root, global } = targetRoot();
  const home = realpathSync(os.homedir());
  let local = root;
  if (global) {
    try {
      local = discover(program.opts<{ cwd: string }>().cwd);
    } catch {
      local = realpathSync(program.opts<{ cwd: string }>().cwd);
    }
  }
  for (const location of new Set([local, home]))
    await refreshCatalogs(location, {
      global: location === home,
      offline: program.opts<{ offline?: boolean }>().offline,
      warn: (message) => console.error(`loadout: ${message}`),
    }).catch((error) => {
      if (location === root) throw error;
    });
  const targets =
    local === home
      ? [loadTarget(home, true)]
      : [loadTarget(local, false), loadTarget(home, true)];
  const initial = global ? targets.length - 1 : 0;
  const current = targets[initial]!;
  if (!current.catalog)
    throw new Error(current.error ?? 'Cannot load kits for this location.');
  return { targets, initial };
}
function showSkipped(result: Plan, preview = false): void {
  for (const skipped of result.skippedInstructions ?? [])
    console.log(
      `Skipped instructions from ${skipped.kits.join(', ')} (${skipped.paths.join(', ')}): ${skipped.reason}.`,
    );
  for (const id of result.kitsWithoutOutputs ?? [])
    console.log(
      `${id}: no agent outputs ${preview ? 'will be applied' : 'applied'}; all instructions skipped.`,
    );
}
function preview(result: Plan, diff = false): void {
  showSkipped(result, true);
  const changed = result.changes.filter(
    (c) => c.kind !== 'unchanged' && !c.path.startsWith('.loadout-personal/'),
  );
  if (!changed.length) {
    console.log(
      hasChanges(result)
        ? 'Local settings will be refreshed.'
        : 'Generated files are unchanged.',
    );
    return;
  }
  console.log('\nPlanned changes:');
  for (const change of changed)
    console.log(
      `  ${change.kind === 'create' ? '+' : change.kind === 'delete' ? '-' : '~'} ${change.path}`,
    );
  if (diff) {
    for (const change of changed) {
      const before = change.before?.content ?? Buffer.alloc(0),
        after = change.after?.content ?? Buffer.alloc(0);
      if (before.equals(after)) continue;
      if (
        before.length + after.length > 200_000 ||
        before.includes(0) ||
        after.includes(0)
      ) {
        console.log(
          `  ${change.path}: binary or large content; inspect the source for details.`,
        );
      } else {
        console.log(
          createTwoFilesPatch(
            `a/${change.path}`,
            `b/${change.path}`,
            before.toString('utf8'),
            after.toString('utf8'),
            undefined,
            undefined,
            { context: 3 },
          ),
        );
      }
    }
  }
}
function showDependencies(catalog: Catalog, state: State): void {
  for (const id of resolveKits(catalog, state.selected))
    if (!state.selected.includes(id))
      console.log(
        `${id} required by ${reasons(catalog, state.selected, id).join(', ')}`,
      );
}
function options(command: Command): Command {
  return command
    .option(
      '--answer <kit.question=value>',
      'set an answer (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      '--adopt',
      'preserve existing instructions and adopt identical skills',
    )
    .option('--diff', 'show text changes in generated files')
    .option('--dry-run', 'preview without writing files or saving selections');
}
async function generate(
  catalog: Catalog,
  state: State,
  opts: Options,
): Promise<void> {
  const previous = catalog;
  catalog = catalogForUpdates(catalog, opts.update);
  setAnswers(catalog, state, opts.answer ?? []);
  const configured = await configure(catalog, state);
  showDependencies(catalog, configured);
  const rendered = await renderWithExternal(previous, configured, {
    update: opts.update,
    offline: program.opts<{ offline?: boolean }>().offline,
    onRetry: (id) => console.log(`Retrying ${id}…`),
    onFetch: (id, source) => console.log(`Fetching ${id} from ${source.repo}…`),
  });
  for (const id of resolveKits(catalog, configured.selected)) {
    const kit = catalog.kits.get(id)!;
    if (kit.external) {
      const source = opts.update?.includes(id)
        ? offeredSource(kit)!
        : (kit.pinned ?? kit.external);
      console.log(
        `${id}: ${source.repo}@${sourceVersion(source).slice(0, 12)} · license: ${source.license}`,
      );
    }
  }
  const result = plan(catalog, configured, rendered, { adopt: opts.adopt });
  preview(
    result,
    opts.diff || !!opts.update?.length || !!result.adopted?.length,
  );
  if (opts.dryRun) console.log('Dry run: no files or selections saved.');
  else {
    const count = apply(result);
    if (count) console.log(`\nLoadout applied (${count} files changed).`);
    showSkipped(result);
  }
}
async function setup(): Promise<void> {
  const { targets, initial } = await interactiveTargets();
  const offline = program.opts<{ offline?: boolean }>().offline;
  await interactive(targets, initial, { offline });
  console.log('\nYour loadout is ready.');
}
program.action(setup);
program
  .command('init')
  .description('create an optional shared catalog and open setup')
  .action(async () => {
    const opts = program.opts<{ cwd: string; global?: boolean }>();
    const root = opts.global ? os.homedir() : opts.cwd;
    const global =
      !!opts.global || realpathSync(root) === realpathSync(os.homedir());
    initialize(root, global);
    console.log(
      `Initialized ${realpathSync(root)}/.loadout${global ? '. Choose kits from Browse.' : ' with an editable starter kit.'}`,
    );
    if (process.stdin.isTTY && process.stdout.isTTY) await setup();
    else
      console.log(
        `Run loadout${global ? ' --global' : ''} in a terminal to choose your kits.`,
      );
  });
program
  .command('list')
  .description('show available kits and why they are enabled')
  .action(async () => {
    const { catalog, state } = await context();
    const enabled = resolveKits(catalog, state.selected);
    for (const kit of catalog.kits.values()) {
      const status =
        kit.ready === false
          ? 'Needs setup'
          : state.selected.includes(kit.id)
            ? 'selected'
            : enabled.includes(kit.id)
              ? `required by ${reasons(catalog, state.selected, kit.id).join(', ')}`
              : 'disabled';
      console.log(
        `${kit.id} [${status}]\n  ${kitSource(kit)} · ${kit.description}`,
      );
    }
    if (!catalog.kits.size)
      console.log('No kits found. Add ~/.loadout/kits/<name>/kit.yaml.');
  });
program
  .command('explain <kit>')
  .description('explain why a kit is enabled')
  .action(async (id: string) => {
    const { catalog, state } = await context();
    if (!catalog.kits.has(id)) throw new Error(`Unknown kit: ${id}`);
    const kit = catalog.kits.get(id)!;
    if (kit.catalog)
      console.log(
        `Catalog: ${kit.catalog.name} (${kit.catalog.url})\nAvailable through: ${kit.unavailable ? 'saved installation; no longer subscribed' : kit.subscriptions?.join(', ')}`,
      );
    if (kit.external) {
      const source = kit.pinned ?? kit.external;
      console.log(
        `Source: https://github.com/${source.repo}/tree/${source.ref}`,
      );
      if (source.integrity)
        console.log(`Kit content hash: ${source.integrity}`);
      console.log(
        source.kit
          ? `Kit directory: ${source.kit.path}`
          : `Skills: ${source.skills.map((skill) => skillName(source, skill)).join(', ')}`,
      );
      if (hasUpdate(kit))
        console.log(
          `A different source revision is offered. Run loadout update ${id} --dry-run to preview it.`,
        );
    }
    const enabled = resolveKits(catalog, state.selected);
    if (!enabled.includes(id)) {
      console.log(`${id} is disabled.`);
      return;
    }
    if (state.selected.includes(id))
      console.log(`${id} is explicitly selected.`);
    for (const dependent of reasons(catalog, state.selected, id))
      console.log(
        `${id} is required by ${dependent} (directly or transitively).`,
      );
  });
options(
  program
    .command('enable <kits...>')
    .description('enable kits and their dependencies'),
).action(async (ids: string[], opts: Options) => {
  const { catalog, state } = await context();
  state.selected = [...state.selected, ...ids];
  await generate(catalog, state, opts);
});
options(
  program
    .command('disable <kit>')
    .description('disable a kit; preserve dependencies still in use')
    .option(
      '--cascade',
      'also disable explicit selections that require this kit',
    ),
).action(async (id: string, opts: Options) => {
  const { catalog, state } = await context();
  if (!catalog.kits.has(id) && !state.selected.includes(id))
    throw new Error(`Unknown kit: ${id}`);
  state.selected = disableKits(
    catalog,
    state.selected,
    id,
    opts.cascade ?? false,
  );
  await generate(catalog, state, opts);
});
options(
  program
    .command('apply')
    .description('regenerate using saved selections and answers'),
).action(async (opts: Options) => {
  const { catalog, state } = await context();
  await generate(catalog, state, opts);
});
program
  .command('outdated')
  .description(
    'compare downloaded external kits with the current catalog (no network)',
  )
  .action(async () => {
    const { catalog, state } = await context(true);
    const enabled = resolveKits(catalog, state.selected);
    const updates = availableUpdates(catalog);
    for (const kit of updates)
      console.log(
        `${kit.id}${enabled.includes(kit.id) ? '' : ' [disabled]'}\n  ${updateDescription(kit)}`,
      );
    console.log(
      updates.length
        ? '\nRun loadout to review enabled kit updates, or loadout update --dry-run.'
        : 'No catalog updates for downloaded external kits.',
    );
    console.log(
      'Compared with this catalog; upstream branches were not checked.',
    );
  });
options(
  program
    .command('update [kits...]')
    .description('update enabled external kits to their catalog revisions'),
).action(async (ids: string[], opts: Options) => {
  const { catalog, state } = await context();
  const update = ids.length
    ? ids
    : availableUpdates(catalog, state.selected).map((kit) => kit.id);
  if (!update.length) {
    console.log('No catalog updates for enabled external kits.');
    return;
  }
  await generate(catalog, state, { ...opts, update });
});
const catalogCommand = program
  .command('catalog')
  .description('manage subscribed kit catalogs');
catalogCommand
  .command('hash <file>')
  .description('calculate kit content hashes in a local catalog manifest')
  .option(
    '--ref <branch>',
    'source branch or tag to resolve (otherwise keep each source locator)',
  )
  .action(async (file: string, opts: { ref?: string }) => {
    if (program.opts<{ offline?: boolean }>().offline)
      throw new Error('Hashing source contents needs an online connection.');
    const document = parseDocument(readFileSync(file, 'utf8'), { merge: true });
    if (document.errors.length)
      throw new Error(document.errors.map((error) => error.message).join('; '));
    const input = document.toJS();
    for (const provider of input.providers ?? [])
      for (const kit of provider.kits ?? []) {
        kit.source.integrity = '0'.repeat(64);
        if (opts.ref) kit.source.ref = opts.ref;
      }
    const manifest = parse(catalogManifestSchema, input, file);
    const requests = new Map<string, Promise<Buffer>>();
    for (const [i, provider] of manifest.providers.entries())
      for (const [j, kit] of provider.kits.entries()) {
        const integrity = await hashSource(kit.source, (url, limit) => {
          if (!requests.has(url)) requests.set(url, fetchBytes(url, limit));
          return requests.get(url)!;
        });
        const source = { ...kit.source, integrity };
        document.setIn(
          ['providers', i, 'kits', j, 'source'],
          Object.fromEntries(
            Object.entries(source).filter(
              ([key, value]) => !(key === 'ref' && value === 'HEAD'),
            ),
          ),
        );
        console.log(`${kit.id}: ${integrity}`);
      }
    writeFileSync(file, document.toString());
  });
catalogCommand
  .command('list')
  .description('show effective catalog URLs and their scopes')
  .action(() => {
    const { root, global } = targetRoot();
    for (const subscription of subscriptions(root, global)) {
      const name = readCatalogCache(subscription.url)?.manifest.name;
      console.log(
        `${name ?? subscription.url} [${subscription.scopes.join(', ')}]${name ? `\n  ${subscription.url}` : ''}`,
      );
    }
  });
for (const action of ['add', 'remove'] as const) {
  catalogCommand
    .command(`${action} <urls...>`)
    .description(`${action} catalog subscriptions (repository by default)`)
    .option(
      '--personal',
      'apply to your home configuration, across all projects',
    )
    .option(
      '--private',
      'apply only to your private configuration in this repository',
    )
    .action(
      async (
        urls: string[],
        opts: { personal?: boolean; private?: boolean },
      ) => {
        if (opts.personal && opts.private)
          throw new Error('Choose --personal or --private, not both.');
        const target = targetRoot();
        const root = opts.personal ? realpathSync(os.homedir()) : target.root;
        const directory = opts.private ? '.loadout-personal' : '.loadout';
        const changed = editSubscription(root, directory, action, ...urls);
        console.log(
          `${changed ? (action === 'add' ? 'Added' : 'Removed') : 'No change to'} catalog subscriptions in ${root}/${directory}/config.yaml`,
        );
        if (action === 'add')
          await refreshCatalogs(root, {
            offline: program.opts<{ offline?: boolean }>().offline,
            warn: (message) => console.error(`loadout: ${message}`),
          });
      },
    );
}
catalogCommand
  .command('refresh')
  .description('refresh subscribed manifests without updating installed kits')
  .action(async () => {
    const { root, global } = targetRoot();
    await refreshCatalogs(root, {
      global,
      force: true,
      offline: program.opts<{ offline?: boolean }>().offline,
      warn: (message) => console.error(`loadout: ${message}`),
    });
  });
try {
  await program.parseAsync();
} catch (error) {
  if (
    error instanceof Error &&
    ['ExitPromptError', 'AbortPromptError', 'DownloadCancelledError'].includes(
      error.name,
    )
  ) {
    console.log('\nCancelled. No kit selections or agent outputs saved.');
    process.exitCode = 130;
  } else {
    console.error(
      `loadout: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
