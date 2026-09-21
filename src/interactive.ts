import { checkbox, confirm, select } from '@inquirer/prompts';
import { configure } from './resolve.js';
import { validAnswer, type Catalog, type State } from './schema.js';
import {
  targetPicker,
  type PickerSession,
  type TargetSelection,
} from './picker.js';
import { type Target } from './targets.js';
import { availableUpdates, updateDescription } from './updates.js';
import { prepareInput } from './terminal.js';

type PromptContext = NonNullable<Parameters<typeof confirm>[1]>;

class BackToPicker extends Error {}

async function backPrompt<T>(
  prompt: (context: PromptContext) => Promise<T>,
  context: PromptContext = {},
): Promise<T> {
  const input: NodeJS.ReadableStream = context.input ?? process.stdin;
  prepareInput(input);
  const controller = new AbortController();
  const back = (_text: string, key: { name?: string }) => {
    if (key.name === 'escape') controller.abort(new BackToPicker());
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
    if (error instanceof Error && error.cause instanceof BackToPicker)
      throw error.cause;
    throw error;
  } finally {
    input.off('keypress', back);
  }
}

export async function interactive(
  targets: Target[],
  initial = 0,
  options: {
    context?: PromptContext;
    review?: (
      selections: TargetSelection[],
      context?: PromptContext,
    ) => Promise<void>;
  } = {},
): Promise<TargetSelection[]> {
  if (!options.context && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Error(
      'Interactive setup needs a terminal. Use loadout enable <kit>, then loadout apply.',
    );
  const session: PickerSession = {};
  for (;;) {
    const chosen = await targetPicker(
      { targets, initial, session },
      options.context,
    );
    try {
      const configured: TargetSelection[] = [];
      for (const { target, state } of chosen) {
        const value = await configureSelection(target, state, options.context);
        configured.push({ target, state: value });
      }
      await options.review?.(configured, options.context);
      return configured;
    } catch (error) {
      if (!(error instanceof BackToPicker)) throw error;
    }
  }
}
export async function configureSelection(
  target: Target,
  state: State,
  context?: Parameters<typeof confirm>[1],
): Promise<State> {
  const change = new Map<string, boolean>();
  return configure(
    target.catalog!,
    state,
    async (kit, key, question, value) => {
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
): Promise<string[]> {
  const updates = availableUpdates(catalog, state.selected);
  if (!updates.length) return [];
  if (offline) {
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
            'Catalog updates available · choose kits to update (Enter skips)',
          choices: updates.map((kit) => ({
            name: kit.id,
            value: kit.id,
            description: updateDescription(kit),
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
): Promise<boolean> {
  return backPrompt(
    (context) =>
      confirm(
        {
          message: `Keep existing content and let Loadout manage ${paths.join(', ')}? Originals will be restored when disabled.`,
          default: true,
        },
        context,
      ),
    context,
  );
}
