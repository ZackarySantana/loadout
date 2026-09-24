import {
  targetPicker,
  type PickerSession,
  type TargetSelection,
} from './picker.js';
import {
  BackNavigation,
  configureSelection,
  confirmSelectionChanges,
  confirmAdoption,
  selectUpdates,
  retryReview,
  type PromptContext,
} from './interactive.js';
import {
  catalogForUpdates,
  type FetchBytes,
  type SnapshotCache,
} from './external.js';
import { applyAll } from './storage.js';
import { prepareInstallations } from './installations.js';
import { reviewScreen, type ReviewTarget } from './review.js';
import { prepareScreen } from './prepare.js';
import { type Target } from './targets.js';
import { suspendEscapeCancellation } from './terminal.js';

export async function interactive(
  targets: Target[],
  initial = 0,
  options: {
    context?: PromptContext;
    offline?: boolean;
    fetch?: FetchBytes;
  } = {},
): Promise<TargetSelection[]> {
  if (!options.context && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Error(
      'Interactive setup needs a terminal. Use loadout enable <kit>, then loadout apply.',
    );
  const session: PickerSession = {};
  const drafts = new Map<Target, ReviewTarget>();
  const cache: SnapshotCache = new Map();
  const context = { ...options.context, clearPromptOnDone: true };
  for (;;) {
    const chosen = await targetPicker({ targets, initial, session }, context);
    const selections = chosen.map(({ target, state }): ReviewTarget => {
      const previous = drafts.get(target);
      const draft = {
        target,
        state: structuredClone({
          ...state,
          answers: previous?.state.answers ?? state.answers,
        }),
        update: previous?.update ?? [],
      };
      drafts.set(target, draft);
      return draft;
    });
    selections.sort(
      (a, b) => targets.indexOf(a.target) - targets.indexOf(b.target),
    );
    const restoreEscape = suspendEscapeCancellation(
      context.input ?? process.stdin,
    );
    try {
      for (;;) {
        try {
          // Finish questions for every destination before starting any downloads.
          for (const selection of selections) {
            const { target, state } = selection;
            selection.update = await selectUpdates(
              target.catalog!,
              state,
              options.offline,
              context,
              {
                message: `${target.label} · Choose catalog updates (Enter keeps your choices)`,
                selected: selection.update,
                quiet: true,
              },
            );
          }
          const configurations = selections.map((selection) => ({
            selection,
            state: selection.state,
            target: {
              ...selection.target,
              catalog: catalogForUpdates(
                selection.target.catalog!,
                selection.update,
              ),
            },
          }));
          const changeSelections = await confirmSelectionChanges(
            configurations,
            context,
          );
          for (const { selection, target, state } of configurations) {
            selection.state = await configureSelection(
              target,
              state,
              context,
              (kit, key, answer) => {
                state.answers[kit] ??= {};
                state.answers[kit]![key] = answer;
              },
              changeSelections,
            );
          }
          const prepared = await prepareScreen(
            {
              selections,
              run: async (progress, retry, signal) => {
                return prepareInstallations(selections, {
                  adopt: true,
                  home: targets.find((target) => target.global)?.root,
                  signal,
                  knownRoots: targets
                    .filter((target) => !target.global)
                    .map((target) => target.root),
                  render: ({ update }, scope) => {
                    progress(scope, 'Preparing kits…');
                    return {
                      offline: options.offline,
                      fetch: options.fetch,
                      update,
                      cache,
                      signal,
                      onFetch: (id) => progress(scope, `Downloading ${id}…`),
                      onRetry: (id) => progress(scope, `Retrying ${id}…`),
                      onReady: (id) => progress(scope, `${id} · Ready`),
                      retry: (id, error) => retry(scope, id, error),
                    };
                  },
                  ready: (scope) => progress(scope, 'Ready'),
                });
              },
            },
            context,
          );
          for (const { target, plan } of prepared) {
            if (
              plan.adopted?.length &&
              !(await confirmAdoption(plan.adopted, context, target.label))
            )
              throw new BackNavigation();
          }
          const action = await reviewScreen({ selections: prepared }, context);
          if (action === 'back') break;
          if (action === 'apply') applyAll(prepared.map(({ plan }) => plan));
          return selections.map(({ target, state }) => ({ target, state }));
        } catch (failure) {
          if (failure instanceof BackNavigation) break;
          if (
            failure instanceof Error &&
            ['ExitPromptError', 'AbortPromptError'].includes(failure.name)
          )
            throw failure;
          if (!(await retryReview(failure, context))) break;
        }
      }
    } finally {
      restoreEscape();
    }
  }
}
