import { checkbox, confirm, select } from '@inquirer/prompts';
import { configure } from './resolve.js';
import {
  validAnswer,
  type Answer,
  type Question,
  type Catalog,
  type State,
} from './schema.js';
import { type Target } from './targets.js';
import { availableUpdates, updateDescription } from './updates.js';
import { prepareInput } from './terminal.js';

export type PromptContext = NonNullable<Parameters<typeof confirm>[1]>;

export class BackNavigation extends Error {}

async function backPrompt<T>(
  prompt: (context: PromptContext) => Promise<T>,
  context: PromptContext = {},
): Promise<T> {
  const input: NodeJS.ReadableStream = context.input ?? process.stdin;
  prepareInput(input);
  const controller = new AbortController();
  const back = (_text: string, key: { name?: string }) => {
    if (key.name === 'escape') controller.abort(new BackNavigation());
  };
  input.on('keypress', back);
  try {
    return await prompt({
      ...context,
      signal: context.signal
        ? AbortSignal.any([context.signal, controller.signal])
        : controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.cause instanceof BackNavigation)
      throw error.cause;
    throw error;
  } finally {
    input.off('keypress', back);
  }
}

export async function configureSelection(
  target: Target,
  state: State,
  context?: Parameters<typeof confirm>[1],
  onAnswer?: (kit: string, key: string, answer: Answer) => void,
): Promise<State> {
  const change = new Map<string, boolean>();
  const ask = async (
    kit: string,
    key: string,
    question: Question,
    value: Answer | undefined,
  ): Promise<Answer> => {
    if (!change.has(kit)) {
      const hasSaved = Object.entries(
        target.catalog!.kits.get(kit)!.questions,
      ).some(([name, q]) => validAnswer(q, state.answers[kit]?.[name]));
      change.set(
        kit,
        hasSaved
          ? await backPrompt(
              (context) =>
                confirm(
                  {
                    message: `${target.label} · ${kit} · Change selection?`,
                    default: false,
                  },
                  context,
                ),
              context,
            )
          : true,
      );
    }
    const saved = state.answers[kit]?.[key];
    if (!change.get(kit) && validAnswer(question, saved)) return saved;
    const message = `${target.label} · ${kit} · ${question.message}`;
    if (question.type === 'boolean')
      return backPrompt(
        (context) =>
          confirm(
            { message, default: typeof value === 'boolean' ? value : false },
            context,
          ),
        context,
      );
    return backPrompt(
      (context) =>
        select(
          {
            message,
            choices: question.choices.map((v) => ({ name: v, value: v })),
            default: typeof value === 'string' ? value : undefined,
          },
          context,
        ),
      context,
    );
  };
  return configure(
    target.catalog!,
    state,
    async (kit, key, question, value) => {
      const answer = await ask(kit, key, question, value);
      onAnswer?.(kit, key, answer);
      return answer;
    },
  );
}

export async function confirmApply(
  context?: PromptContext,
  scopes: string[] = [],
): Promise<boolean> {
  return backPrompt(
    (context) =>
      confirm(
        {
          message: scopes.length
            ? `Apply changes to ${scopes.join(' and ')}?`
            : 'Apply changes?',
          default: true,
        },
        context,
      ),
    context,
  );
}

export async function selectUpdates(
  catalog: Catalog,
  state: State,
  offline = false,
  context?: Parameters<typeof checkbox>[1],
  options: { message?: string; selected?: string[]; quiet?: boolean } = {},
): Promise<string[]> {
  const updates = availableUpdates(catalog, state.selected);
  if (!updates.length) return [];
  if (offline) {
    if (!options.quiet)
      console.log(
        `${updates.length} catalog update(s) available. Run loadout online to review them; keeping saved versions.`,
      );
    return [];
  }
  return backPrompt(
    (context) =>
      checkbox(
        {
          message:
            options.message ??
            'Catalog updates available · choose kits to update (Enter skips)',
          choices: updates.map((kit) => ({
            name: kit.id,
            value: kit.id,
            description: updateDescription(kit),
            checked: options.selected?.includes(kit.id) ?? false,
          })),
          required: false,
        },
        context,
      ),
    context,
  );
}

export async function confirmRetry(
  id: string,
  error: Error,
  context?: Parameters<typeof select>[1],
): Promise<boolean> {
  return backPrompt(
    (context) =>
      select(
        {
          message: `${id}: ${error.message}`,
          choices: [
            { name: 'Retry download', value: true },
            { name: 'Cancel', value: false },
          ],
        },
        context,
      ),
    context,
  );
}

export async function confirmAdoption(
  paths: string[],
  context?: Parameters<typeof confirm>[1],
  scope?: string,
): Promise<boolean> {
  return backPrompt(
    (context) =>
      confirm(
        {
          message: `${scope ? `${scope} · ` : ''}Keep existing content and let Loadout manage ${paths.join(', ')}? Originals will be restored when disabled.`,
          default: true,
        },
        context,
      ),
    context,
  );
}

export async function retryReview(
  error: unknown,
  context?: PromptContext,
): Promise<boolean> {
  try {
    return await backPrompt(
      (context) =>
        select(
          {
            message: `Could not finish: ${error instanceof Error ? error.message : String(error)}`,
            choices: [
              { name: 'Try again', value: true },
              { name: 'Back to kits', value: false },
            ],
          },
          context,
        ),
      context,
    );
  } catch (failure) {
    if (failure instanceof BackNavigation) return false;
    throw failure;
  }
}
