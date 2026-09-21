import {
  targetPicker,
  type PickerSession,
  type TargetSelection,
} from './picker.js';
import {
  BackNavigation,
  configureSelection,
  confirmAdoption,
  selectUpdates,
  retryReview,
  type PromptContext,
} from './interactive.js';
import {
  renderWithExternal,
  type FetchBytes,
  type SnapshotCache,
} from './external.js';
import { applyAll, plan } from './storage.js';
import {
  reviewScreen,
  type PreparedTarget,
  type ReviewTarget,
} from './review.js';
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
    for (const [target, draft] of drafts) {
      if (selections.some((selection) => selection.target === target)) continue;
      // The picker omits inactive scopes whose checkboxes match saved state.
      // They can still have draft answers, but must use the latest checkboxes.
      draft.state.selected = [
        ...(session.snapshot?.selections[targets.indexOf(target)] ??
          draft.state.selected),
      ];
      if (
        draft.update.length ||
        JSON.stringify(draft.state.answers) !==
          JSON.stringify(target.state?.answers ?? {})
      )
        selections.push(draft);
    }
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
            selection.state = await configureSelection(
              target,
              state,
              context,
              (kit, key, answer) => {
                state.answers[kit] ??= {};
                state.answers[kit]![key] = answer;
              },
            );
            selection.update = await selectUpdates(
              target.catalog!,
              selection.state,
              options.offline,
              context,
              {
                message: `${target.label} · Choose catalog updates (Enter keeps your choices)`,
                selected: selection.update,
                quiet: true,
              },
            );
          }
          const prepared = await prepareScreen(
            {
              selections,
              run: async (progress, retry, signal) => {
                const prepared: PreparedTarget[] = [];
                for (const [scope, selection] of selections.entries()) {
                  const { target, state, update } = selection;
                  progress(scope, 'Preparing kits…');
                  const rendered = await renderWithExternal(
                    target.catalog!,
                    state,
                    {
                      offline: options.offline,
                      fetch: options.fetch,
                      update,
                      cache,
                      signal,
                      onFetch: (id) => progress(scope, `Downloading ${id}…`),
                      onRetry: (id) => progress(scope, `Retrying ${id}…`),
                      onReady: (id) => progress(scope, `${id} · Ready`),
                      retry: (id, error) => retry(scope, id, error),
                    },
                  );
                  signal.throwIfAborted();
                  progress(scope, 'Checking file changes…');
                  prepared.push({
                    ...selection,
                    plan: plan(target.catalog!, state, rendered, {
                      adopt: true,
                    }),
                  });
                  progress(scope, 'Ready');
                }
                return prepared;
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
