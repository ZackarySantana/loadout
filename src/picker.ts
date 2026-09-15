import {
  createPrompt,
  useEffect,
  useKeypress,
  useState,
  isEnterKey,
  isSpaceKey,
} from '@inquirer/core';
import { stripVTControlCharacters, styleText } from 'node:util';
import path from 'node:path';
import stringWidth from 'string-width';
import { resolveKits, reasons } from './resolve.js';
import { kitSource, type Catalog, type Kit, type State } from './schema.js';
import { type Target } from './targets.js';
import { availableUpdates, hasUpdate } from './updates.js';
import { prepareInput } from './terminal.js';
import { providerDescriptions } from './curated.js';

const accent = (value: string) => styleText('cyan', value);
const muted = (value: string) => styleText('dim', value);
const bold = (value: string) => styleText('bold', value);
const clean = (value: string) =>
  stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f]/g, ' ');
function fit(value: string, width: number): string {
  const text = clean(value);
  if (stringWidth(text) <= width) return text;
  let result = '';
  for (const character of text) {
    if (stringWidth(result + character) > width - 1) break;
    result += character;
  }
  return width > 0 ? `${result}…` : '';
}
function wordmark(width: number, rows: number): string[] {
  if (width < 43 || rows < 20) return ['', `  ${accent(bold('LOADOUT'))}`, ''];
  return [
    '',
    accent('  █    █▀▀█ █▀▀█ █▀▀▄ █▀▀█ █  █ ▀▀█▀▀'),
    accent('  █    █  █ █▄▄█ █  █ █  █ █  █   █'),
    accent('  █▄▄█ █▄▄█ █  █ █▄▄▀ █▄▄█ ▀▄▄▀   █'),
    '',
  ];
}
export type PickerConfig = {
  catalog: Catalog;
  selected: string[];
  columns?: number;
  rows?: number;
};
const repositorySections = ['Kits', 'Browse', 'Installed'] as const;
type Section = (typeof repositorySections)[number];
type Row = {
  id: string;
  description: string;
  kit?: Kit;
  action?: 'continue';
  count?: number;
  selectedCount?: number;
  downloadedCount?: number;
};
const providerFor = (kit: Kit): string | undefined =>
  kit.origin === 'bundled' ? 'loadout' : kit.external?.repo;
const providerPrefixes: Readonly<Record<string, string>> = {
  loadout: 'loadout-',
  'mattpocock/skills': 'matt-pocock-',
  'anthropics/skills': 'anthropic-',
};

export type TargetPickerConfig = {
  targets: Target[];
  initial?: number;
  columns?: number;
  rows?: number;
  initialize?: (target: Target) => Target;
};
export type TargetSelection = { target: Target; state: State };
const emptyState = (): State => ({
  schemaVersion: 1,
  selected: [],
  answers: {},
});

const renderPicker = createPrompt<TargetSelection[], TargetPickerConfig>(
  (config, done) => {
    const [targets, setTargets] = useState(config.targets);
    const [targetIndex, setTargetIndex] = useState(config.initial ?? 0);
    const [visited, setVisited] = useState([config.initial ?? 0]);
    const [selections, setSelections] = useState(
      config.targets.map((target) =>
        (target.state?.selected ?? []).filter(
          (id) =>
            target.catalog?.kits.has(id) &&
            target.catalog.kits.get(id)?.ready !== false,
        ),
      ),
    );
    const [pending, setPending] = useState<number | undefined>(undefined);
    const [pendingSwitch, setPendingSwitch] = useState<number | undefined>(
      undefined,
    );
    const [notice, setNotice] = useState('');
    const target = targets[targetIndex]!;
    const sections: readonly Section[] = target.global
      ? ['Browse', 'Installed']
      : repositorySections;
    const catalog = target.catalog ?? {
      root: target.root,
      kits: new Map<string, Kit>(),
    };
    const selected = selections[targetIndex]!;
    const hasSelectionChanges =
      JSON.stringify([...selected].sort()) !==
      JSON.stringify([...(target.state?.selected ?? [])].sort());
    const setSelected = (value: string[]) =>
      setSelections(
        selections.map((ids, index) => (index === targetIndex ? value : ids)),
      );
    const [section, setSection] = useState<Section>(
      target.global ? 'Browse' : 'Kits',
    );
    const [scopeFocused, setScopeFocused] = useState(false);
    const [provider, setProvider] = useState<string | undefined>(undefined);
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const [finished, setFinished] = useState(false);
    const [size, setSize] = useState({
      columns: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    });
    useEffect(() => {
      const resize = () =>
        setSize({
          columns: process.stdout.columns || 80,
          rows: process.stdout.rows || 24,
        });
      process.stdout.on('resize', resize);
      return () => {
        process.stdout.off('resize', resize);
      };
    }, []);
    const width = Math.max(12, (config.columns ?? size.columns) - 2);
    const height = config.rows ?? size.rows;
    const enabled = resolveKits(catalog, selected);
    const enabledSet = new Set(enabled);
    const installedSet = new Set(
      resolveKits(
        catalog,
        (target.state?.selected ?? []).filter(
          (id) => catalog.kits.has(id) && catalog.kits.get(id)?.ready !== false,
        ),
      ),
    );
    const willUninstall = (id: string) =>
      installedSet.has(id) && !enabledSet.has(id);
    const requiredCount = enabled.length - selected.length;
    const all = [...catalog.kits.values()];
    const matches = (kit: Kit) =>
      `${kit.id} ${kit.description} ${kitSource(kit)} ${kit.external?.repo ?? ''} ${kit.external?.skills.join(' ') ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase());
    const browsingProviders = section === 'Browse' && !provider;
    const displayName = (id: string): string => {
      const kit = catalog.kits.get(id);
      if (
        section !== 'Browse' ||
        !provider ||
        !kit ||
        providerFor(kit) !== provider
      )
        return id;
      const prefix = providerPrefixes[provider];
      return prefix && id.startsWith(prefix) && id.length > prefix.length
        ? id.slice(prefix.length)
        : id;
    };
    let entries: Row[];
    if (browsingProviders) {
      const providers = new Map<string, Kit[]>();
      for (const kit of all) {
        const name = providerFor(kit);
        if (!name) continue;
        const kits = providers.get(name) ?? [];
        kits.push(kit);
        providers.set(name, kits);
      }
      entries = [...providers]
        .sort(([a], [b]) =>
          a === 'loadout' ? -1 : b === 'loadout' ? 1 : a.localeCompare(b),
        )
        .flatMap(([id, kits]) => {
          const matching = kits.filter(matches);
          if (!matching.length) return [];
          const count = kits.filter((kit) => enabledSet.has(kit.id)).length;
          const origins = new Set(kits.map((kit) => kit.origin));
          const description =
            id === 'loadout'
              ? 'Included with Loadout'
              : origins.has('curated') && providerDescriptions[id]
                ? providerDescriptions[id]!
                : origins.size > 1
                  ? 'Curated and repository sources'
                  : origins.has('curated')
                    ? 'Curated kits'
                    : 'Repository sources';
          return [
            {
              id,
              count: matching.length,
              description,
              selectedCount: count,
              downloadedCount: kits.filter((kit) => !!kit.pinned).length,
            },
          ];
        });
    } else {
      entries = all
        .filter((kit) => {
          if (!matches(kit)) return false;
          if (section === 'Kits') return !providerFor(kit);
          if (section === 'Installed')
            return (
              !!providerFor(kit) &&
              (!!kit.pinned ||
                enabledSet.has(kit.id) ||
                installedSet.has(kit.id))
            );
          return providerFor(kit) === provider;
        })
        .sort((a, b) => Number(a.ready === false) - Number(b.ready === false))
        .map((kit) => ({ id: kit.id, description: kit.description, kit }));
    }
    entries.push({
      id: '@continue',
      action: 'continue',
      description: 'Review selections and apply',
    });
    const cursor = Math.min(active, Math.max(0, entries.length - 1));
    const focused = entries[cursor];
    useKeypress((key, rl) => {
      const reset = () => {
        setQuery('');
        setActive(0);
        rl.clearLine(0);
      };
      const restoreInput = () => {
        rl.clearLine(0);
        rl.write(query);
      };
      const switchTarget = (index: number) => {
        setScopeFocused(false);
        setTargetIndex(index);
        setSection(targets[index]!.global ? 'Browse' : 'Kits');
        setVisited([...new Set([...visited, index])]);
        setProvider(undefined);
        setNotice('');
        reset();
      };
      if (pendingSwitch !== undefined) {
        if (key.name === 'y') {
          switchTarget(pendingSwitch);
          setPendingSwitch(undefined);
        } else if (
          key.name === 'n' ||
          key.name === 'escape' ||
          isEnterKey(key)
        ) {
          setPendingSwitch(undefined);
          restoreInput();
        }
        return;
      }
      if (pending !== undefined) {
        if (key.name === 'y' && config.initialize) {
          try {
            const initialized = config.initialize(targets[pending]!);
            if (!initialized.catalog)
              throw new Error(
                initialized.error ??
                  'Initialization did not produce a catalog.',
              );
            setTargets(
              targets.map((item, index) =>
                index === pending ? initialized : item,
              ),
            );
            setSelections(
              selections.map((ids, index) =>
                index === pending ? (initialized.state?.selected ?? []) : ids,
              ),
            );
            switchTarget(pending);
          } catch (error) {
            setNotice((error as Error).message);
          }
          setPending(undefined);
        } else if (
          key.name === 'n' ||
          key.name === 'escape' ||
          isEnterKey(key)
        ) {
          setPending(undefined);
        }
        restoreInput();
        return;
      }
      if (scopeFocused && (isEnterKey(key) || isSpaceKey(key))) {
        setScopeFocused(false);
        const next = (targetIndex + 1) % targets.length;
        const other = targets[next]!;
        if (other.error) setNotice(other.error);
        else if (!other.catalog) {
          setPending(next);
          reset();
        } else if (hasSelectionChanges) {
          setPendingSwitch(next);
        } else switchTarget(next);
        rl.clearLine(0);
        return;
      }
      if (['tab', 'left', 'right'].includes(key.name)) {
        const index = scopeFocused
          ? sections.length
          : sections.indexOf(section);
        const count = sections.length + (targets.length > 1 ? 1 : 0);
        const backwards =
          key.name === 'left' || (key.name === 'tab' && key.shift);
        const next = (index + (backwards ? -1 : 1) + count) % count;
        setScopeFocused(next === sections.length);
        if (next !== sections.length) {
          setSection(sections[next]!);
          setProvider(undefined);
          reset();
        } else restoreInput();
      } else if (key.name === 'up' || key.name === 'down') {
        setScopeFocused(false);
        if (entries.length)
          setActive(
            (cursor + (key.name === 'up' ? -1 : 1) + entries.length) %
              entries.length,
          );
        restoreInput();
      } else if (isEnterKey(key) || isSpaceKey(key)) {
        if (focused?.action === 'continue') {
          setFinished(true);
          done(
            targets.flatMap((item, index) => {
              if (!item.catalog || !visited.includes(index)) return [];
              const ids = [...selections[index]!].sort();
              const saved = item.state ?? emptyState();
              if (
                index !== targetIndex &&
                JSON.stringify(ids) ===
                  JSON.stringify([...saved.selected].sort())
              )
                return [];
              return [{ target: item, state: { ...saved, selected: ids } }];
            }),
          );
        } else if (browsingProviders && focused) {
          setProvider(focused.id);
          setActive(0);
        } else if (focused?.kit && focused.kit.ready !== false) {
          setSelected(
            selected.includes(focused.id)
              ? selected.filter((id) => id !== focused.id)
              : [...selected, focused.id],
          );
          setActive(cursor);
        }
        rl.clearLine(0);
        rl.write(query);
      } else if (key.name === 'escape') {
        if (scopeFocused) {
          setScopeFocused(false);
          restoreInput();
        } else {
          if (!query && provider) setProvider(undefined);
          reset();
        }
      } else if (!['left', 'right', 'home', 'end'].includes(key.name)) {
        setScopeFocused(false);
        setQuery(clean(rl.line));
        setActive(0);
      }
    });
    const header = wordmark(width, height);
    const other =
      targets.length > 1
        ? targets[(targetIndex + 1) % targets.length]
        : undefined;
    const switchLabel = other
      ? `[ Go to ${other.label}${other.error ? ' !' : ''} ]`
      : '';
    const scopeLabel =
      width >= 60 ? `${target.label} · ${target.root}` : target.label;
    const scopeText = fit(scopeLabel, width - switchLabel.length - 4);
    const scopeLines =
      targets.length > 1 || target.global
        ? [
            `  ${bold(scopeText)}${' '.repeat(Math.max(2, width - stringWidth(scopeText) - switchLabel.length - 2))}${scopeFocused ? accent(bold(switchLabel)) : muted(switchLabel)}`,
            ...(width < 60 ? [`  ${muted(fit(target.root, width - 2))}`] : []),
          ]
        : [];
    const selectionWarning = hasSelectionChanges
      ? [
          `  ${fit(`Unapplied changes in ${target.label}.`, width - 2)}`,
          '  Selections stay in this session.',
        ]
      : [];
    if (pendingSwitch !== undefined)
      return [
        ...header,
        ...scopeLines,
        '',
        `  ${bold(fit(`Switch to ${targets[pendingSwitch]!.label}?`, width - 2))}`,
        ...selectionWarning,
        '',
        `  ${accent('[Enter/Esc]')} Stay   ${accent('[y]')} Switch`,
        '\u001b[?25l',
      ].join('\n');
    if (pending !== undefined) {
      const destination = targets[pending]!;
      const pathWidth = width - 9;
      const catalogPath = path.join(destination.root, '.loadout');
      const displayPath =
        stringWidth(clean(catalogPath)) <= pathWidth
          ? clean(catalogPath)
          : destination.global
            ? '~/.loadout'
            : `${fit(destination.root, pathWidth - 9)}/.loadout`;
      return [
        ...header,
        ...scopeLines,
        '',
        `  ${bold(fit(`Set up ${destination.label} and switch?`, width - 2))}`,
        `  ${fit(`Create ${displayPath}`, width - 2)}`,
        ...selectionWarning,
        '',
        `  ${accent('[Enter/Esc]')} Cancel   ${accent('[y]')} Set up`,
        '\u001b[?25l',
      ].join('\n');
    }
    if (finished)
      return [
        ...header,
        `  ${accent('✓')} ${selected.length} selected${requiredCount ? muted(` · ${requiredCount} required`) : ''}\n`,
      ].join('\n');

    const updates = availableUpdates(catalog).length;
    const counts = `${selected.length} selected${requiredCount ? ` · ${requiredCount} required` : ''}`;
    const tabs =
      width >= 34
        ? `  ${sections.map((name) => (name === section && !scopeFocused ? accent(bold(`[${name}]`)) : muted(name))).join('    ')}`
        : `  ${scopeFocused ? muted(section) : accent(bold(`[${section}]`))} ${muted('←→/tab')}`;
    const filter = `  ${accent('/')} ${query ? `${fit(query, width - 6)}${accent('▏')}` : muted(browsingProviders ? 'Search providers or kits' : 'Search kits')}`;
    const rule = `  ${muted('─'.repeat(width - 2))}`;
    const detailed = height >= 20;
    const hints = scopeFocused
      ? [
          `space/enter ${other?.error ? 'details' : other?.catalog ? 'switch' : 'setup'}`,
          '←→/tab move',
          'esc back',
        ]
      : [
          '↑↓ move',
          `space/enter ${focused?.action ? 'select' : browsingProviders ? 'open' : 'toggle'}`,
          '←→/tab switch',
          `esc ${provider ? 'back' : 'clear'}`,
        ];
    const helpLines: string[] = [];
    const separator = width >= 100 ? '    ' : ' · ';
    for (const hint of hints) {
      const previous = helpLines.at(-1);
      const combined = previous ? `${previous}${separator}${hint}` : hint;
      if (previous && stringWidth(combined) <= width - 2)
        helpLines[helpLines.length - 1] = combined;
      else helpLines.push(fit(hint, width - 2));
    }
    const help = helpLines.map((line) => `  ${muted(line)}`);
    if (scopeFocused && other) {
      const action = other.error
        ? `${other.label} is unavailable`
        : `${other.catalog ? 'Switch to' : 'Set up'} ${other.label}`;
      return [
        ...header,
        ...scopeLines,
        '',
        tabs,
        rule,
        `  ${bold(fit(action, width - 2))}`,
        ...(other.error ? [`  ${fit(other.error, width - 2)}`] : []),
        `  ${muted(fit(other.root, width - 2))}`,
        rule,
        ...help,
        '\u001b[?25l',
      ].join('\n');
    }
    const beforeList = [
      ...header,
      ...scopeLines,
      ...(scopeLines.length && detailed ? [''] : []),
      tabs,
      ...(provider ? [`  ${muted(fit(provider, width - 2))}`] : []),
      ...(detailed ? [''] : []),
      rule,
      filter,
      ...(detailed ? [''] : []),
    ];
    const summary = fit(
      `${counts}${updates ? ` · ${updates} updates` : ''}`,
      width - 6,
    );
    const bottomRule = `  ${muted(`${'─'.repeat(Math.max(1, width - stringWidth(summary) - 6))}  ${summary} ─`)}`;
    // Border, detail, spacing, keyboard help, and cursor-control line.
    const footerHeight = 5 + help.length;
    const pageSize = Math.max(
      1,
      Math.min(
        8,
        Math.floor(
          (height - beforeList.length - footerHeight) / (detailed ? 2 : 1),
        ),
      ),
    );
    const listEntries = entries.filter((row) => !row.action);
    const listCursor = Math.min(cursor, Math.max(0, listEntries.length - 1));
    const start = Math.max(
      0,
      Math.min(
        listCursor - Math.floor(pageSize / 2),
        listEntries.length - pageSize,
      ),
    );
    const page = listEntries.slice(start, start + pageSize);
    const lines: string[] = [];
    for (const row of page) {
      const focus = row.id === focused?.id;
      const explicit = selected.includes(row.id);
      const required = enabledSet.has(row.id) && !explicit;
      const providerStatus = [
        row.selectedCount
          ? `${row.selectedCount} ${width >= 76 ? 'selected' : 'sel'}`
          : '',
        row.downloadedCount
          ? `${row.downloadedCount} ${width >= 76 ? 'downloaded' : 'dl'}`
          : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const label = !row.kit
        ? [
            width >= 76 || !providerStatus ? `${row.count} kits` : '',
            providerStatus,
          ]
            .filter(Boolean)
            .join(' · ')
        : row.kit.ready === false
          ? 'Needs setup'
          : willUninstall(row.id)
            ? 'Will uninstall'
            : hasUpdate(row.kit)
              ? 'update'
              : explicit
                ? 'selected'
                : required
                  ? 'required'
                  : row.kit.pinned
                    ? 'saved'
                    : '';
      const marker = !row.kit
        ? accent('▸')
        : explicit
          ? accent('●')
          : required
            ? styleText('yellow', '◆')
            : muted('○');
      const badge =
        required || willUninstall(row.id) || (row.kit && hasUpdate(row.kit))
          ? styleText('yellow', label)
          : muted(label);
      const name = fit(displayName(row.id), width - label.length - 9);
      const gap = ' '.repeat(
        Math.max(2, width - stringWidth(name) - label.length - 6),
      );
      lines.push(
        `  ${focus ? accent('›') : ' '} ${marker} ${row.kit?.ready === false ? muted(name) : focus ? bold(name) : name}${gap}${badge}`,
      );
      if (detailed)
        lines.push(
          `      ${muted(fit(row.kit && section === 'Installed' ? `${kitSource(row.kit)} · ${row.description}` : row.description, width - 6))}`,
        );
    }
    if (!page.length) {
      const empty = !catalog.kits.size
        ? 'No kits in this catalog.'
        : query
          ? 'No matching kits. Esc to clear.'
          : section === 'Kits'
            ? 'No repository kits. Tab to browse.'
            : section === 'Installed'
              ? 'No kits installed. Tab to browse.'
              : 'No external providers configured.';
      lines.push(`  ${muted(fit(empty, width - 2))}`);
    }
    const kit = focused?.kit;
    const why = kit ? reasons(catalog, selected, kit.id) : [];
    const detail = focused?.action
      ? focused.description
      : browsingProviders
        ? [
            focused?.selectedCount ? `${focused.selectedCount} selected` : '',
            focused?.downloadedCount
              ? `${focused.downloadedCount} downloaded`
              : '',
          ]
            .filter(Boolean)
            .join(' · ') || 'Choose a provider to explore its kits'
        : kit?.ready === false
          ? 'Edit this kit, then set ready: true in kit.yaml'
          : kit && willUninstall(kit.id)
            ? 'Uninstall on apply. Select again to keep.'
            : kit && hasUpdate(kit)
              ? `Catalog update · ${kit.pinned!.ref.slice(0, 8)} → ${kit.external!.ref.slice(0, 8)}`
              : why.length
                ? `Required by ${why.map(displayName).join(', ')}${selected.includes(kit!.id) ? ' · also selected' : ' · space to keep explicitly'}`
                : kit?.requires.length
                  ? `Requires ${kit.requires.map(displayName).join(', ')}`
                  : kit?.external
                    ? `Includes ${(kit.pinned ?? kit.external).skills.map((p) => p.split('/').at(-1)).join(', ')}`
                    : '';
    const pagination =
      listEntries.length > page.length
        ? `${start + 1}–${start + page.length} of ${listEntries.length}`
        : '';
    return [
      ...beforeList,
      ...lines,
      bottomRule,
      `  ${focused?.action ? accent('›') : ' '} ${focused?.action ? accent(bold('[ Continue ]')) : '[ Continue ]'}`,
      `  ${muted(fit(notice || [pagination, detail].filter(Boolean).join(' · '), width - 2))}`,
      '',
      ...help,
      '\u001b[?25l',
    ].join('\n');
  },
);

export function targetPicker(
  config: TargetPickerConfig,
  context?: Parameters<typeof renderPicker>[1],
): Promise<TargetSelection[]> {
  prepareInput(context?.input ?? process.stdin);
  return renderPicker(config, context);
}

// Single-location entry point for consumers that only need selected IDs.
export async function kitPicker(
  config: PickerConfig,
  context?: Parameters<typeof targetPicker>[1],
): Promise<string[]> {
  const result = await targetPicker(
    {
      targets: [
        {
          label: 'Repository',
          root: config.catalog.root,
          global: false,
          catalog: config.catalog,
          state: { ...emptyState(), selected: config.selected },
        },
      ],
      columns: config.columns,
      rows: config.rows,
    },
    context,
  );
  return result[0]!.state.selected;
}
