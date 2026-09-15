import {
  validAnswer,
  type Answer,
  type Catalog,
  type Question,
  type State,
} from './schema.js';

export function resolveKits(catalog: Catalog, selected: string[]): string[] {
  const done = new Set<string>();
  const visiting: string[] = [];
  const visit = (id: string) => {
    if (done.has(id)) return;
    if (visiting.includes(id))
      throw new Error(`Dependency cycle: ${[...visiting, id].join(' -> ')}`);
    const kit = catalog.kits.get(id);
    if (!kit)
      throw new Error(
        `Unknown kit: ${id}${visiting.length ? ` (required by ${visiting.at(-1)})` : '. Remove it with loadout disable if it was deleted from the catalog.'}`,
      );
    if (kit.ready === false)
      throw new Error(
        `${id} needs setup before it can be selected. Edit its kit.yaml and set ready: true.`,
      );
    visiting.push(id);
    for (const required of [...kit.requires].sort()) visit(required);
    visiting.pop();
    done.add(id);
  };
  for (const id of [...new Set(selected)].sort()) visit(id);
  return [...done];
}
export function reasons(
  catalog: Catalog,
  selected: string[],
  target: string,
): string[] {
  return [...new Set(selected)]
    .sort()
    .filter(
      (id) => id !== target && resolveKits(catalog, [id]).includes(target),
    );
}
export function disableKits(
  catalog: Catalog,
  selected: string[],
  target: string,
  cascade: boolean,
): string[] {
  // A removed catalog kit can still be deselected to recover saved state.
  const dependents = reasons(
    catalog,
    selected.filter((id) => catalog.kits.has(id)),
    target,
  );
  if (dependents.length && !cascade)
    throw new Error(
      `${target} is required by: ${dependents.join(', ')}. Use --cascade to disable those selections too.`,
    );
  return selected.filter(
    (id) => id !== target && (!cascade || !dependents.includes(id)),
  );
}
export async function configure(
  catalog: Catalog,
  state: State,
  ask?: (
    kit: string,
    key: string,
    question: Question,
    saved: Answer | undefined,
  ) => Promise<Answer>,
): Promise<State> {
  const next = structuredClone(state);
  next.selected = [...new Set(next.selected)].sort();
  for (const id of resolveKits(catalog, next.selected)) {
    for (const [key, question] of Object.entries(
      catalog.kits.get(id)!.questions,
    ).sort(([a], [b]) => a.localeCompare(b))) {
      if (!Object.hasOwn(next.answers, id)) next.answers[id] = {};
      const saved = Object.hasOwn(next.answers[id]!, key)
        ? next.answers[id]![key]
        : undefined;
      let answer: Answer | undefined = saved ?? question.default;
      if (ask)
        answer = await ask(
          id,
          key,
          question,
          validAnswer(question, answer) ? answer : undefined,
        );
      if (!validAnswer(question, answer))
        throw new Error(
          `${id}.${key}: ${answer === undefined ? 'missing required answer' : 'invalid saved answer'}. Run loadout or pass --answer ${id}.${key}=VALUE.`,
        );
      next.answers[id]![key] = answer;
    }
  }
  return next;
}
export function setAnswers(
  catalog: Catalog,
  state: State,
  values: string[],
): void {
  for (const value of values) {
    const match = /^([a-z0-9-]+)\.([a-z0-9-]+)=(.*)$/.exec(value);
    if (!match)
      throw new Error(`Invalid answer ${value}; expected kit.question=value`);
    const id = match[1]!,
      key = match[2]!,
      raw = match[3]!;
    const questions = catalog.kits.get(id)?.questions;
    const q =
      questions && Object.hasOwn(questions, key) ? questions[key] : undefined;
    if (!q) throw new Error(`Unknown question: ${id}.${key}`);
    const answer =
      q.type === 'boolean'
        ? raw === 'true'
          ? true
          : raw === 'false'
            ? false
            : raw
        : raw;
    if (!validAnswer(q, answer))
      throw new Error(`Invalid answer for ${id}.${key}: ${raw}`);
    if (!Object.hasOwn(state.answers, id)) state.answers[id] = {};
    state.answers[id]![key] = answer;
  }
}
