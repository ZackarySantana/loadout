import {
  createPrompt,
  isEnterKey,
  isSpaceKey,
  useEffect,
  useKeypress,
  useState,
} from '@inquirer/core';
import { createTwoFilesPatch } from 'diff';
import { stripVTControlCharacters, styleText } from 'node:util';
import stringWidth from 'string-width';
import { type TargetSelection } from './picker.js';
import { type PromptContext } from './interactive.js';
import { kitSource, offeredSource, sourceVersion } from './schema.js';
import { catalogForUpdates } from './external.js';
import { reasons, resolveKits } from './resolve.js';
import { hasChanges, type Change, type Plan } from './storage.js';
import { suspendEscapeCancellation } from './terminal.js';

export type ReviewTarget = TargetSelection & { update: string[]; plan?: Plan };
export type PreparedTarget = ReviewTarget & { plan: Plan };
export type ReviewAction = 'back' | 'apply' | 'done';
type Row = {
  text: string;
  scope?: number;
  heading?: boolean;
  warning?: boolean;
  expand?: number;
  file?: Change;
};
export type KitReview = {
  id: string;
  effect: 'Add' | 'Remove' | 'Update' | 'Configure' | 'Keep';
  notes: string[];
  unchanged: boolean;
};

// Compare effective kits, not just checkboxes: a deselected dependency may stay enabled.
export function selectionSummary({
  target,
  state,
  update,
}: ReviewTarget): KitReview[] {
  const previous = target.catalog!;
  const catalog = catalogForUpdates(previous, update);
  const saved = target.state ?? { schemaVersion: 1, selected: [], answers: {} };
  const old = new Set([
    ...resolveKits(
      previous,
      saved.selected.filter(
        (id) => previous.kits.has(id) && previous.kits.get(id)?.ready !== false,
      ),
    ),
    ...saved.selected,
  ]);
  const next = new Set(resolveKits(catalog, state.selected));
  return [...new Set([...old, ...next])].sort().map((id) => {
    const kit = catalog.kits.get(id);
    const explicitChanged =
      saved.selected.includes(id) !== state.selected.includes(id);
    const answerKeys = Object.keys(kit?.questions ?? {}).sort();
    const configured =
      next.has(id) &&
      answerKeys.some(
        (key) => saved.answers[id]?.[key] !== state.answers[id]?.[key],
      );
    const effect = !next.has(id)
      ? 'Remove'
      : !old.has(id)
        ? 'Add'
        : update.includes(id)
          ? 'Update'
          : configured
            ? 'Configure'
            : 'Keep';
    const notes: string[] = [];
    if (next.has(id) && !state.selected.includes(id))
      notes.push(
        `${saved.selected.includes(id) ? 'still required' : 'dependency'} of ${reasons(catalog, state.selected, id).join(', ')}`,
      );
    else if (effect === 'Keep' && explicitChanged)
      notes.push('chosen directly');
    if (effect === 'Update' && kit?.external)
      notes.push(
        `${kit.pinned ? sourceVersion(kit.pinned).slice(0, 7) : 'saved'} → ${sourceVersion(offeredSource(kit)!).slice(0, 7)}`,
      );
    if (next.has(id))
      for (const key of answerKeys) {
        const answer = state.answers[id]?.[key];
        if (answer !== undefined)
          notes.push(
            `${key === 'placement' ? 'Install as' : key.replaceAll('-', ' ')}: ${answer}`,
          );
      }
    if (kit && kitSource(kit) !== 'Repository') notes.push(kitSource(kit));
    return {
      id,
      effect,
      notes,
      unchanged: effect === 'Keep' && !explicitChanged,
    };
  });
}

const outputChanges = (plan: Plan) =>
  plan.changes.filter(
    (change) =>
      change.kind !== 'unchanged' &&
      !change.path.startsWith('.loadout-personal/'),
  );

export function reviewRows(
  selections: ReviewTarget[],
  expanded: number[],
): Row[] {
  const rows: Row[] = [];
  const summaries = selections.map(selectionSummary);
  if (!selections.some(({ plan }) => plan && hasChanges(plan)))
    rows.push({ text: 'No changes to apply' });
  selections.forEach(({ target, plan }, scope) => {
    const kits = summaries[scope]!;
    rows.push({
      text: `${target.label} · ${target.root}`,
      scope,
      heading: true,
    });
    const changed = kits.filter((kit) => !kit.unchanged);
    const unchanged = kits.filter((kit) => kit.unchanged);
    const kitRow = (kit: KitReview): Row => ({
      text: `  ${kit.effect.padEnd(9)} ${kit.id}${kit.notes.length ? ` · ${kit.notes.join(' · ')}` : ''}`,
      scope,
    });
    rows.push(...changed.map(kitRow));
    if (unchanged.length) {
      rows.push({
        text: `  ${expanded.includes(scope) ? '▾' : '▸'} Unchanged (${unchanged.length})`,
        scope,
        expand: scope,
      });
      if (expanded.includes(scope)) rows.push(...unchanged.map(kitRow));
    }
    if (!kits.length) rows.push({ text: '  No kits selected', scope });
    if (plan) {
      if (plan.inherited?.length)
        rows.push({
          text: `  Provided by Global: ${plan.inherited.join(', ')}`,
          scope,
        });
      const changes = outputChanges(plan);
      const counts = (['create', 'update', 'delete'] as const).flatMap(
        (kind) => {
          const count = changes.filter((change) => change.kind === kind).length;
          return count
            ? [`${count} ${kind === 'delete' ? 'remove' : kind}`]
            : [];
        },
      );
      if (counts.length)
        rows.push({ text: `  Files: ${counts.join(' · ')}`, scope });
      else if (hasChanges(plan)) rows.push({ text: '  Settings only', scope });
      if (plan.adopted?.length)
        rows.push({
          text: `  Existing content kept: ${plan.adopted.join(', ')}`,
          scope,
        });
      for (const skipped of plan.skippedInstructions ?? [])
        rows.push({
          text: `  Skipped instructions · ${skipped.kits.join(', ')}: ${skipped.reason} (${skipped.paths.join(', ')})`,
          scope,
          warning: true,
        });
      for (const id of plan.kitsWithoutOutputs ?? [])
        rows.push({
          text: `  ${id}: no agent outputs will be applied`,
          scope,
          warning: true,
        });
    }
    rows.push({ text: '' });
  });
  return rows;
}

function fileRows(selections: ReviewTarget[]): Row[] {
  return selections.flatMap(({ target, state, update, plan }, scope) => {
    const catalog = catalogForUpdates(target.catalog!, update);
    const rows: Row[] = [
      { text: `${target.label} · ${target.root}`, scope, heading: true },
    ];
    for (const id of resolveKits(catalog, state.selected)) {
      const kit = catalog.kits.get(id)!;
      if (!kit.external) continue;
      const source = update.includes(id)
        ? offeredSource(kit)!
        : (kit.pinned ?? kit.external);
      rows.push({
        text: `${id}: ${source.repo}@${sourceVersion(source)} · license: ${source.license}`,
        scope,
      });
    }
    const files = plan ? outputChanges(plan) : [];
    rows.push(
      ...files.map((file) => ({
        text: `${file.kind === 'create' ? '+' : file.kind === 'delete' ? '-' : '~'} ${file.path}`,
        scope,
        file,
      })),
    );
    if (!files.length) rows.push({ text: 'No agent file changes', scope });
    rows.push({ text: '' });
    return rows;
  });
}

function diffRows(row: Row): Row[] {
  const file = row.file!;
  const before = file.before?.content ?? Buffer.alloc(0);
  const after = file.after?.content ?? Buffer.alloc(0);
  const header: Row = { text: file.path, scope: row.scope, heading: true };
  if (before.equals(after))
    return [header, { text: 'File mode changed; content is unchanged.' }];
  if (
    before.length + after.length > 200_000 ||
    before.includes(0) ||
    after.includes(0)
  )
    return [
      header,
      { text: 'Binary or large content; inspect the source for details.' },
    ];
  return [
    header,
    ...createTwoFilesPatch(
      `a/${file.path}`,
      `b/${file.path}`,
      before.toString('utf8'),
      after.toString('utf8'),
      undefined,
      undefined,
      { context: 3 },
    )
      .split('\n')
      .map((text) => ({ text, scope: row.scope })),
  ];
}

export function wrapReviewText(value: string, width: number): string[] {
  const text = stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f]/g, ' ');
  const lines: string[] = [];
  let line = '';
  for (const character of text) {
    if (line && stringWidth(line + character) > width) {
      lines.push(line);
      line = '';
    }
    line += character;
  }
  lines.push(line);
  return lines;
}

type ReviewConfig = {
  selections: ReviewTarget[];
  columns?: number;
  rows?: number;
};
const screen = createPrompt<ReviewAction, ReviewConfig>((config, done) => {
  const [expanded, setExpanded] = useState<number[]>([]);
  const [view, setView] = useState<'summary' | 'files' | 'diff'>('summary');
  const [diff, setDiff] = useState<Row[]>([]);
  const [active, setActive] = useState<number | undefined>(undefined);
  const [lastContent, setLastContent] = useState(0);
  const [summaryCursor, setSummaryCursor] = useState(0);
  const [fileCursor, setFileCursor] = useState(0);
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
  const width = Math.max(16, (config.columns ?? size.columns) - 4);
  const changed = config.selections.some(
    ({ plan }) => plan && hasChanges(plan),
  );
  const actions: { label: string; value: ReviewAction | 'files' | 'close' }[] =
    view !== 'summary'
      ? [
          {
            label: view === 'diff' ? 'Back to files' : 'Back to review',
            value: 'close',
          },
        ]
      : [
          { label: 'Back to kits', value: 'back' },
          { label: 'View files', value: 'files' },
          {
            label: changed ? 'Apply changes' : 'Done',
            value: changed ? 'apply' : 'done',
          },
        ];
  const content =
    view === 'diff'
      ? diff
      : view === 'files'
        ? fileRows(config.selections)
        : reviewRows(config.selections, expanded);
  const rows = content.flatMap((row) =>
    wrapReviewText(row.text, width - 2).map((text, index) => ({
      ...row,
      text,
      ...(index ? { expand: undefined, file: undefined } : {}),
    })),
  );
  const cursor = Math.min(
    active ?? rows.length + actions.length - 1,
    rows.length + actions.length - 1,
  );
  const focus = (index: number) => {
    setActive(index);
    if (index < rows.length) setLastContent(index);
  };
  const pageSize = Math.min(
    rows.length,
    Math.max(2, (config.rows ?? size.rows) - actions.length - 5),
  );
  const start = Math.max(
    0,
    Math.min(
      (cursor < rows.length ? cursor : lastContent) - Math.floor(pageSize / 2),
      rows.length - pageSize,
    ),
  );
  const back = () => {
    if (view === 'diff') {
      setView('files');
      setActive(fileCursor);
    } else if (view === 'files') {
      setView('summary');
      setActive(summaryCursor);
    } else done('back');
  };
  useKeypress((key, rl) => {
    rl.clearLine(0);
    if (key.name === 'escape') {
      back();
      return;
    }
    if (key.name === 'tab') {
      const index =
        cursor < rows.length
          ? key.shift
            ? actions.length
            : -1
          : cursor - rows.length;
      setActive(
        rows.length +
          ((index + (key.shift ? -1 : 1) + actions.length) % actions.length),
      );
    } else if (key.name === 'home') focus(0);
    else if (key.name === 'end') setActive(rows.length + actions.length - 1);
    else if (['up', 'down', 'pageup', 'pagedown'].includes(key.name)) {
      const step = key.name.startsWith('page') ? pageSize : 1;
      const backwards = key.name === 'up' || key.name === 'pageup';
      const length = rows.length + actions.length;
      focus((cursor + ((backwards ? -step : step) % length) + length) % length);
    } else if (isEnterKey(key) || isSpaceKey(key)) {
      const action = actions[cursor - rows.length];
      if (action?.value === 'close') back();
      else if (action?.value === 'files') {
        setSummaryCursor(cursor);
        setView('files');
        setActive(0);
        setLastContent(0);
      } else if (action) done(action.value as ReviewAction);
      else {
        const row = rows[cursor];
        if (row?.expand !== undefined)
          setExpanded(
            expanded.includes(row.expand)
              ? expanded.filter((scope) => scope !== row.expand)
              : [...expanded, row.expand],
          );
        if (row?.file) {
          setFileCursor(cursor);
          setDiff(diffRows(row));
          setView('diff');
          setActive(0);
          setLastContent(0);
        }
      }
    }
  });
  const accent = (text: string) =>
    styleText(
      config.selections.every(({ target }) => target.global)
        ? 'magenta'
        : 'cyan',
      text,
    );
  const title =
    view === 'files'
      ? 'Files · Enter to inspect a diff'
      : view === 'diff'
        ? 'File diff'
        : 'Review changes';
  const page = rows.slice(start, start + pageSize).map((row, index) => {
    const global =
      row.scope !== undefined && config.selections[row.scope]?.target.global;
    const text = row.warning
      ? styleText('yellow', row.text)
      : row.heading
        ? styleText(global ? 'magenta' : 'cyan', styleText('bold', row.text))
        : row.text;
    return `  ${start + index === cursor ? styleText(global ? 'magenta' : 'cyan', '›') : ' '} ${text}`;
  });
  return [
    `  ${accent(styleText('bold', title))}`,
    '',
    ...page,
    ...actions.map(
      (action, index) =>
        `  ${cursor === rows.length + index ? accent('›') : ' '} ${cursor === rows.length + index ? accent(`[ ${action.label} ]`) : `[ ${action.label} ]`}`,
    ),
    `  ${styleText('dim', `↑↓ move · Tab actions · Enter select · Esc back${rows.length > pageSize ? ` · ${start + 1}–${Math.min(start + pageSize, rows.length)}/${rows.length}` : ''}`)}`,
    '\u001b[?25l',
  ]
    .map((line) =>
      stringWidth(line) > width + 4
        ? wrapReviewText(line, width + 4)[0]!
        : line,
    )
    .join('\n');
});

export async function reviewScreen(
  config: ReviewConfig,
  context?: PromptContext,
): Promise<ReviewAction> {
  const restore = suspendEscapeCancellation(context?.input ?? process.stdin);
  try {
    return await screen(config, { ...context, clearPromptOnDone: true });
  } finally {
    restore();
  }
}
