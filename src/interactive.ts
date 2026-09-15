import { checkbox, confirm, select } from '@inquirer/prompts';
import { configure } from './resolve.js';
import { validAnswer, type Catalog, type State } from './schema.js';
import { targetPicker, type TargetSelection } from './picker.js';
import { initializeTarget, type Target } from './targets.js';
import { availableUpdates, updateDescription } from './updates.js';

export async function interactive(
  targets: Target[],
  initial = 0,
): Promise<TargetSelection[]> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      'Interactive setup needs a terminal. Use loadout enable <kit>, then loadout apply.',
    );
  const chosen = await targetPicker({
    targets,
    initial,
    initialize: initializeTarget,
  });
  const configured: TargetSelection[] = [];
  for (const { target, state } of chosen) {
    const value = await configureSelection(target, state);
    configured.push({ target, state: value });
  }
  return configured;
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
            ? await confirm(
                {
                  message: `${target.label} · ${kit} · Change selection?`,
                  default: false,
                },
                context,
              )
            : true,
        );
      }
      const saved = state.answers[kit]?.[key];
      if (!change.get(kit) && validAnswer(question, saved)) return saved;
      const message = `${target.label} · ${kit} · ${question.message}`;
      if (question.type === 'boolean')
        return confirm(
          { message, default: typeof value === 'boolean' ? value : false },
          context,
        );
      return select(
        {
          message,
          choices: question.choices.map((v) => ({ name: v, value: v })),
          default: typeof value === 'string' ? value : undefined,
        },
        context,
      );
    },
  );
}

export async function confirmApply(): Promise<boolean> {
  return confirm({ message: 'Apply changes?', default: true });
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
  return checkbox(
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
  );
}

export async function confirmRetry(
  id: string,
  error: Error,
  context?: Parameters<typeof select>[1],
): Promise<boolean> {
  return select(
    {
      message: `${id}: ${error.message}`,
      choices: [
        { name: 'Retry download', value: true },
        { name: 'Cancel', value: false },
      ],
    },
    context,
  );
}

export async function confirmAdoption(
  paths: string[],
  context?: Parameters<typeof confirm>[1],
): Promise<boolean> {
  return confirm(
    {
      message: `Keep existing content and let Loadout manage ${paths.join(', ')}? Originals will be restored when disabled.`,
      default: true,
    },
    context,
  );
}
