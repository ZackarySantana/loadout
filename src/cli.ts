#!/usr/bin/env node
import { Command } from 'commander';
import { createTwoFilesPatch } from 'diff';
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import { discover } from './catalog.js';
import { initialize } from './init.js';
import {
  interactive,
  confirmApply,
  selectUpdates,
  confirmRetry,
  confirmAdoption,
} from './interactive.js';
import { apply, applyAll, hasChanges, plan, type Plan } from './storage.js';
import { renderWithExternal } from './external.js';
import { DownloadCancelledError } from './retry.js';
import { loadTarget, type Target } from './targets.js';
import {
  configure,
  disableKits,
  reasons,
  resolveKits,
  setAnswers,
} from './resolve.js';
import { kitSource, type Catalog, type State } from './schema.js';
import { availableUpdates, hasUpdate, updateDescription } from './updates.js';

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
function context(): { catalog: Catalog; state: State } {
  const { root, global } = targetRoot();
  const target = loadTarget(root, global);
  if (!target.catalog || !target.state)
    throw new Error(target.error ?? 'Cannot load kits for this location.');
  return { catalog: target.catalog, state: target.state };
}
function interactiveTargets(): { targets: Target[]; initial: number } {
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
  setAnswers(catalog, state, opts.answer ?? []);
  const configured = await configure(catalog, state);
  showDependencies(catalog, configured);
  const rendered = await renderWithExternal(catalog, configured, {
    update: opts.update,
    offline: program.opts<{ offline?: boolean }>().offline,
    onRetry: (id) => console.log(`Retrying ${id}…`),
    onFetch: (id, source) => console.log(`Fetching ${id} from ${source.repo}…`),
  });
  for (const id of resolveKits(catalog, configured.selected)) {
    const kit = catalog.kits.get(id)!;
    if (kit.external) {
      const source = opts.update?.includes(id)
        ? kit.external
        : (kit.pinned ?? kit.external);
      console.log(
        `${id}: ${source.repo}@${source.ref.slice(0, 12)} · license: ${source.license}`,
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
  const { targets, initial } = interactiveTargets();
  const configured = await interactive(targets, initial);
  const offline = program.opts<{ offline?: boolean }>().offline;
  const plans: Plan[] = [];
  for (const { target, state } of configured) {
    const catalog = target.catalog!;
    console.log(`\n${target.label} · ${target.root}`);
    const update = await selectUpdates(catalog, state, offline);
    const rendered = await renderWithExternal(catalog, state, {
      offline,
      update,
      retry: confirmRetry,
      onRetry: (id) => console.log(`Retrying ${id}…`),
      onFetch: (id, source) =>
        console.log(`Fetching ${id} from ${source.repo}…`),
    });
    for (const id of resolveKits(catalog, state.selected)) {
      const kit = catalog.kits.get(id)!;
      if (kit.external) {
        const source = update.includes(id)
          ? kit.external
          : (kit.pinned ?? kit.external);
        console.log(
          `${id}: ${source.repo}@${source.ref.slice(0, 12)} · license: ${source.license}`,
        );
      }
    }
    const result = plan(catalog, state, rendered, { adopt: true });
    preview(result, update.length > 0 || !!result.adopted?.length);
    if (result.adopted?.length && !(await confirmAdoption(result.adopted)))
      throw new DownloadCancelledError();
    plans.push(result);
  }
  if (!plans.some(hasChanges)) return;
  if (await confirmApply()) {
    applyAll(plans);
    console.log('\nYour loadout is ready.');
    for (const result of plans) {
      if (!result.skippedInstructions?.length) continue;
      console.log(result.root);
      showSkipped(result);
    }
  } else console.log('Cancelled. No kit selections or agent outputs saved.');
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
  .action(() => {
    const { catalog, state } = context();
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
  .action((id: string) => {
    const { catalog, state } = context();
    if (!catalog.kits.has(id)) throw new Error(`Unknown kit: ${id}`);
    const kit = catalog.kits.get(id)!;
    if (kit.external) {
      const source = kit.pinned ?? kit.external;
      console.log(
        `Source: https://github.com/${source.repo}/tree/${source.ref}`,
      );
      console.log(
        `Skills: ${source.skills.map((p) => p.split('/').at(-1)).join(', ')}`,
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
  const { catalog, state } = context();
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
  const { catalog, state } = context();
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
  const { catalog, state } = context();
  await generate(catalog, state, opts);
});
program
  .command('outdated')
  .description(
    'compare downloaded external kits with the current catalog (no network)',
  )
  .action(() => {
    const { catalog, state } = context();
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
  const { catalog, state } = context();
  const update = ids.length
    ? ids
    : availableUpdates(catalog, state.selected).map((kit) => kit.id);
  if (!update.length) {
    console.log('No catalog updates for enabled external kits.');
    return;
  }
  await generate(catalog, state, { ...opts, update });
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
