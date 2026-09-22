import {
  createPrompt,
  useEffect,
  useKeypress,
  useState,
  isEnterKey,
  isSpaceKey,
} from '@inquirer/core';
import { stripVTControlCharacters, styleText } from 'node:util';
import stringWidth from 'string-width';
import path from 'node:path';
import { resolveKits, reasons } from './resolve.js';
import {
  kitSource,
  offeredSource,
  sourceVersion,
  type Catalog,
  type Kit,
  type State,
} from './schema.js';
import { type Target } from './targets.js';
import { availableUpdates, hasUpdate } from './updates.js';
import { prepareInput } from './terminal.js';

const muted = (value: string) => styleText('dim', value);
const bold = (value: string) => styleText('bold', value);
const scopeColor = (target: Target, value: string) =>
  styleText(target.global ? 'magenta' : 'cyan', value);
const clean = (value: string) =>
  stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f]/g, ' ');
function installationTime(value: string): string {
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
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
function wordmark(
  width: number,
  rows: number,
  accent: (value: string) => string,
): string[] {
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
  action?: 'back' | 'review';
  count?: number;
  selectedCount?: number;
  downloadedCount?: number;
};
const providerFor = (kit: Kit): string | undefined =>
  kit.catalog
    ? kit.catalog.provider
    : kit.origin === 'bundled'
      ? kitSource(kit)
      : (kit.external?.repo ??
        (kit.origin === 'personal' ? 'Personal' : undefined));

export type TargetPickerConfig = {
  targets: Target[];
  initial?: number;
  columns?: number;
  rows?: number;
  session?: PickerSession;
};
type PickerView = {
  section: Section;
  provider: string | undefined;
  providerList: { query: string; active: number };
  query: string;
  active: number;
};
const initialView = (target: Target): PickerView => ({
  section:
    target.global ||
    ![...(target.catalog?.kits.values() ?? [])].some((kit) => !providerFor(kit))
      ? 'Browse'
      : 'Kits',
  provider: undefined,
  providerList: { query: '', active: 0 },
  query: '',
  active: 0,
});
export type PickerSession = {
  snapshot?: PickerView & {
    targetIndex: number;
    visited: number[];
    selections: string[][];
    views: PickerView[];
  };
};
export type TargetSelection = { target: Target; state: State };
const emptyState = (): State => ({
  schemaVersion: 1,
  selected: [],
  answers: {},
});

const renderPicker = createPrompt<TargetSelection[], TargetPickerConfig>(
  (config, done) => {
    const snapshot = config.session?.snapshot;
    const targets = config.targets;
    const [views, setViews] = useState(
      snapshot?.views ?? targets.map(initialView),
    );
    const [targetIndex, setTargetIndex] = useState(
      snapshot?.targetIndex ?? config.initial ?? 0,
    );
    const [visited, setVisited] = useState(
      snapshot?.visited ?? [config.initial ?? 0],
    );
    const [selections, setSelections] = useState(
      snapshot?.selections ??
        config.targets.map((target) =>
          (target.state?.selected ?? []).filter(
            (id) =>
              target.catalog?.kits.has(id) &&
              target.catalog.kits.get(id)?.ready !== false,
          ),
        ),
    );
    const [notice, setNotice] = useState('');
    const target = targets[targetIndex]!;
    const accent = (value: string) => scopeColor(target, value);
    const sections: readonly Section[] = target.global
      ? ['Browse', 'Installed']
      : repositorySections;
    const catalog = target.catalog ?? {
      root: target.root,
      kits: new Map<string, Kit>(),
    };
    const selected = selections[targetIndex]!;
    const pendingTargets = targets.filter(
      (item, index) =>
        JSON.stringify([...selections[index]!].sort()) !==
        JSON.stringify([...(item.state?.selected ?? [])].sort()),
    );
    const setSelected = (value: string[]) =>
      setSelections(
        selections.map((ids, index) => (index === targetIndex ? value : ids)),
      );
    const [section, setSection] = useState<Section>(
      snapshot?.section ?? views[targetIndex]!.section,
    );
    const [provider, setProvider] = useState<string | undefined>(
      snapshot?.provider,
    );
    const [providerList, setProviderList] = useState(
      snapshot?.providerList ?? { query: '', active: 0 },
    );
    const [query, setQuery] = useState(snapshot?.query ?? '');
    const [active, setActive] = useState(snapshot?.active ?? 0);
    useEffect((rl) => {
      if (snapshot?.query) rl.write(snapshot.query);
    }, []);
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
      const prefix = kit.catalog?.prefix;
      return prefix && id.startsWith(prefix) && id.length > prefix.length
        ? id.slice(prefix.length)
        : id;
    };
    let entries: Row[];
    if (browsingProviders) {
      const providers = new Map<string, Kit[]>();
      for (const kit of all) {
        if (kit.unavailable) continue;
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
          const info = kits.find((kit) => kit.catalog)?.catalog;
          const scopes = [
            ...new Set(kits.flatMap((kit) => kit.subscriptions ?? [])),
          ];
          const description = info
            ? `${info.description}${scopes.length ? ` · ${scopes.join(', ')}` : ''}`
            : id === 'Personal'
              ? 'Your personal kits'
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
          if (kit.unavailable && section !== 'Installed') return false;
          if (section === 'Kits') return !providerFor(kit);
          if (section === 'Installed') return installedSet.has(kit.id);
          return providerFor(kit) === provider;
        })
        .sort((a, b) => {
          if (section === 'Installed') {
            const time = (id: string) =>
              target.installedAt?.[id] ? Date.parse(target.installedAt[id]) : 0;
            return time(b.id) - time(a.id);
          }
          return Number(a.ready === false) - Number(b.ready === false);
        })
        .map((kit) => ({ id: kit.id, description: kit.description, kit }));
    }
    if (provider)
      entries.push({
        id: '@back',
        action: 'back',
        description: 'Keeps your selections',
      });
    entries.push({
      id: '@review',
      action: 'review',
      description: '',
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
      const backToProviders = () => {
        setProvider(undefined);
        setQuery(providerList.query);
        setActive(providerList.active);
        rl.clearLine(0);
        rl.write(providerList.query);
      };
      const switchTarget = (index: number) => {
        if (index === targetIndex) {
          restoreInput();
          return;
        }
        const next = targets[index]!;
        if (next.error || !next.catalog) {
          setNotice(next.error ?? 'Cannot load this location.');
          restoreInput();
          return;
        }
        setViews(
          views.map((view, index) =>
            index === targetIndex
              ? { section, provider, providerList, query, active: cursor }
              : view,
          ),
        );
        const view = views[index]!;
        setTargetIndex(index);
        setSection(view.section);
        setProvider(view.provider);
        setProviderList(view.providerList);
        setQuery(view.query);
        setActive(view.active);
        setVisited([...new Set([...visited, index])]);
        setNotice('');
        rl.clearLine(0);
        rl.write(view.query);
      };
      if (key.name === 'tab') {
        switchTarget(
          (targetIndex + (key.shift ? -1 : 1) + targets.length) %
            targets.length,
        );
        return;
      }
      if (['left', 'right'].includes(key.name)) {
        const index = sections.indexOf(section);
        const count = sections.length;
        const backwards = key.name === 'left';
        const next = (index + (backwards ? -1 : 1) + count) % count;
        setSection(sections[next]!);
        setProvider(undefined);
        reset();
      } else if (key.name === 'up' || key.name === 'down') {
        if (entries.length)
          setActive(
            (cursor + (key.name === 'up' ? -1 : 1) + entries.length) %
              entries.length,
          );
        restoreInput();
      } else if (isEnterKey(key) || isSpaceKey(key)) {
        if (focused?.action === 'back') {
          backToProviders();
          return;
        } else if (focused?.action === 'review') {
          if (config.session)
            config.session.snapshot = {
              targetIndex,
              visited,
              selections,
              views,
              section,
              provider,
              providerList,
              query,
              active: cursor,
            };
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
          setProviderList({ query, active: cursor });
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
        if (!query && provider) backToProviders();
        else reset();
      } else if (!['left', 'right', 'home', 'end'].includes(key.name)) {
        setQuery(clean(rl.line));
        setActive(0);
      }
    });
    const scopeLabels = targets.map(
      (item, index) =>
        `[${index === targetIndex ? '●' : '○'} ${clean(item.label)}${pendingTargets.includes(item) ? '*' : ''}${item.error || !item.catalog ? ' !' : ''}]`,
    );
    const baseWidth =
      scopeLabels.reduce((sum, label) => sum + stringWidth(label), 0) +
      (targets.length - 1) * 2;
    const repositoryIndex = targets.findIndex((item) => !item.global);
    const nameWidth = width - 4 - baseWidth - 3;
    if (repositoryIndex >= 0 && nameWidth >= 3) {
      const repository = targets[repositoryIndex]!;
      const name = fit(
        path.basename(repository.root) || repository.root,
        nameWidth,
      );
      scopeLabels[repositoryIndex] = scopeLabels[repositoryIndex]!.replace(
        clean(repository.label),
        () => `${clean(repository.label)} · ${name}`,
      );
    }
    const segments = targets.map((item, index) => {
      const label = scopeLabels[index]!;
      const colored = scopeColor(item, label);
      return index === targetIndex
        ? bold(colored)
        : pendingTargets.includes(item)
          ? colored
          : muted(colored);
    });
    const selectorWidth =
      segments.reduce((sum, item) => sum + stringWidth(item), 0) +
      (segments.length - 1) * 2;
    const scopeLines =
      selectorWidth <= width - 4
        ? [`    ${segments.join('  ')}`]
        : segments.map((item) => `    ${item}`);
    if (finished)
      return [
        ...wordmark(width, height, accent),
        `  ${accent('✓')} ${selected.length} selected${requiredCount ? muted(` · ${requiredCount} required`) : ''}\n`,
      ].join('\n');

    const updates = availableUpdates(catalog, selected).length;
    const counts = `${selected.length} selected${requiredCount ? ` · ${requiredCount} required` : ''}`;
    const tabLabel = (name: Section) =>
      name === 'Browse' && provider ? `Browse › ${clean(provider)}` : name;
    const inlineProvider =
      !!provider && sections.map(tabLabel).join('    ').length + 2 <= width - 2;
    const tabs =
      width >= 34
        ? `  ${sections
            .map((name) => {
              const label = inlineProvider ? tabLabel(name) : name;
              return name === section
                ? accent(bold(`[${label}]`))
                : muted(label);
            })
            .join('    ')}`
        : `  ${accent(bold(`[${section}]`))}`;
    const filter = `  ${accent('/')} ${query ? `${fit(query, width - 6)}${accent('▏')}` : muted(browsingProviders ? 'Search providers or kits' : 'Search kits')}`;
    const escapeHint = query ? 'Esc clear' : provider ? 'Esc back' : '';
    const hints = [
      ...(width >= 60 ? ['↑↓ move'] : []),
      focused?.action
        ? 'Enter select'
        : browsingProviders
          ? 'Space open'
          : 'Space toggle',
      targets.length > 1 ? 'Tab switch scope' : '←→ tabs',
      escapeHint,
    ].filter(Boolean);
    let helpText = '';
    for (const hint of hints) {
      const combined = helpText ? `${helpText} · ${hint}` : hint;
      if (stringWidth(combined) <= width - 2) helpText = combined;
    }
    const help = [`  ${muted(helpText)}`];
    const beforeList = [
      ...scopeLines,
      tabs,
      ...(provider && !inlineProvider
        ? [`  ${muted(fit(provider, width - 2))}`]
        : []),
      filter,
    ];
    const summary = fit(
      `${counts}${updates ? ` · ${updates} updates` : ''}`,
      width - 6,
    );
    const actions = entries.filter((row) => row.action);
    const kit = focused?.kit;
    const why = kit ? reasons(catalog, selected, kit.id) : [];
    const detail =
      notice ||
      (kit?.ready === false
        ? (kit.problem ?? 'Edit this kit, then set ready: true in kit.yaml')
        : kit && willUninstall(kit.id)
          ? 'Uninstall on apply. Select again to keep.'
          : why.length
            ? `Required by ${why.map(displayName).join(', ')}${selected.includes(kit!.id) ? ' · also selected' : ' · space to keep explicitly'}`
            : kit?.requires.length
              ? `Requires ${kit.requires.map(displayName).join(', ')}`
              : kit && hasUpdate(kit)
                ? `Catalog update · ${sourceVersion(kit.pinned!).slice(0, 8)} → ${sourceVersion(offeredSource(kit)!).slice(0, 8)}`
                : '');
    // Keep the contextual row allocated so focus changes never move the footer.
    const footerHeight = 3 + actions.length + help.length;
    // Prefer useful list rows over decorative branding on short terminals.
    const header = wordmark(width, height, accent);
    const headerBudget =
      height - beforeList.length - footerHeight - (height >= 20 ? 8 : 4);
    if (header.length <= headerBudget) beforeList.unshift(...header);
    else if (headerBudget >= 1)
      beforeList.unshift(`  ${accent(bold('LOADOUT'))}`);
    const spacing = height - beforeList.length - footerHeight >= 8 ? 1 : 0;
    if (spacing) beforeList.push('');
    const pageSize = Math.max(
      1,
      Math.min(
        8,
        Math.floor(
          (height - beforeList.length - footerHeight) /
            (section === 'Installed' ? 3 : 2),
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
              : required
                ? 'required'
                : row.kit.pinned && !explicit
                  ? 'saved'
                  : row.kit.unavailable
                    ? 'unsubscribed'
                    : '';
      const marker = !row.kit
        ? accent('▸')
        : explicit
          ? accent('●')
          : required
            ? styleText('yellow', '◆')
            : muted(accent('○'));
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
        `      ${muted(fit(row.kit && section === 'Installed' ? `${kitSource(row.kit)} · ${row.description}` : row.description, width - 6))}`,
      );
      if (section === 'Installed' && row.kit) {
        const timestamp = target.installedAt?.[row.id];
        const installed = timestamp
          ? `Installed ${installationTime(timestamp)}`
          : 'Installed';
        lines.push(`      ${muted(fit(installed, width - 6))}`);
      }
    }
    if (!page.length) {
      const empty = !catalog.kits.size
        ? 'No kits in this catalog.'
        : query
          ? 'No matching kits. Esc to clear.'
          : section === 'Kits'
            ? 'No repository kits. ←→ to browse.'
            : section === 'Installed'
              ? 'No kits installed. ←→ to browse.'
              : 'No external providers configured.';
      lines.push(`  ${muted(fit(empty, width - 2))}`);
    }
    const pagination =
      listEntries.length > page.length
        ? `${start + 1}–${start + page.length} of ${listEntries.length}`
        : '';
    const status = fit(
      [summary, pagination].filter(Boolean).join(' · '),
      width - 6,
    );
    const bottomRule = `  ${muted('─'.repeat(Math.max(1, width - stringWidth(status) - 6)))}  ${scopeColor(target, status)} ${muted('─')}`;
    return [
      ...beforeList,
      ...lines,
      `  ${muted(fit(detail, width - 2))}`,
      bottomRule,
      ...actions.map((row) => {
        const label =
          row.action === 'back'
            ? width >= 25
              ? 'Back to providers'
              : 'Back'
            : width >= 22
              ? 'Review changes'
              : 'Review';
        const button = fit(`[ ${label} ]`, width - 4);
        const focus = row.id === focused?.id;
        const helperWidth = width - stringWidth(button) - 6;
        const helper =
          row.description && helperWidth > 0
            ? `  ${muted(fit(row.description, helperWidth))}`
            : '';
        return `  ${focus ? accent('›') : ' '} ${focus ? accent(bold(button)) : button}${helper}`;
      }),
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
