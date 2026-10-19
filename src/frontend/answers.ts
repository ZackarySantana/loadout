import { defaults, type Answers, type Kit } from "../domain/kit"

/** Reuse only answers that still make sense under an explicitly chosen update. */
export function answersForUpdate(
  kit: Kit,
  previous: Answers,
): {
  answers: Answers
  reset: string[]
  removed: number
} {
  const answers = defaults(kit)
  const reset: string[] = []
  for (const question of kit.questions) {
    const value = previous[question.id]
    if (value === undefined) {
      reset.push(question.label)
      continue
    }
    if (question.type === "input") {
      if (typeof value === "string" && (!question.required || value.trim()))
        answers[question.id] = value
      else reset.push(question.label)
    } else if (question.type === "boolean") {
      if (typeof value === "boolean") answers[question.id] = value
      else reset.push(question.label)
    } else if (question.type === "select") {
      if (
        typeof value === "string" &&
        question.choices.some((choice) => choice.value === value)
      )
        answers[question.id] = value
      else reset.push(question.label)
    } else if (Array.isArray(value)) {
      const available = new Set(question.choices.map((choice) => choice.value))
      const retained = [
        ...new Set(value.filter((entry) => available.has(entry))),
      ]
      answers[question.id] = retained
      if (retained.length !== value.length) reset.push(question.label)
    } else reset.push(question.label)
  }
  const ids = new Set(kit.questions.map((question) => question.id))
  return {
    answers,
    reset,
    removed: Object.keys(previous).filter((id) => !ids.has(id)).length,
  }
}
