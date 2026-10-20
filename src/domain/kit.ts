import { z } from "zod"

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/)
const value = z.union([z.string(), z.boolean()])
const relativePath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path
        .split("/")
        .every((part) => part !== ".." && part !== "." && part !== ""),
    "Use a relative path without traversal",
  )

export const conditionSchema = z
  .object({
    question: id,
    equals: value.optional(),
    includes: z.string().optional(),
  })
  .strict()
  .refine(
    (c) => (c.equals !== undefined) !== (c.includes !== undefined),
    "Use exactly one of equals or includes",
  )

const baseQuestion = {
  id,
  label: z.string().min(1),
  description: z.string().optional(),
  when: conditionSchema.optional(),
}
const choices = z
  .array(
    z.object({ value: z.string().min(1), label: z.string().min(1) }).strict(),
  )
  .min(1)
export const questionSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...baseQuestion,
      type: z.literal("input"),
      default: z.string().optional(),
      required: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      ...baseQuestion,
      type: z.literal("boolean"),
      default: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      ...baseQuestion,
      type: z.literal("select"),
      choices,
      default: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...baseQuestion,
      type: z.literal("multi-select"),
      choices,
      default: z.array(z.string()).default([]),
    })
    .strict(),
])

export const outputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("instructions"),
      targets: z
        .array(z.enum(["AGENTS.md", "CLAUDE.md"]))
        .min(1)
        .optional(),
      content: z.string(),
      when: conditionSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("skill"),
      name: id,
      files: z
        .record(relativePath, z.string())
        .refine((files) => "SKILL.md" in files, "A skill requires SKILL.md"),
      when: conditionSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("file"),
      path: relativePath,
      content: z.string(),
      when: conditionSchema.optional(),
    })
    .strict(),
])

export const kitSchema = z
  .object({
    id,
    name: z.string().min(1),
    description: z.string().default(""),
    questions: z.array(questionSchema).default([]),
    outputs: z.array(outputSchema).min(1),
  })
  .strict()
  .superRefine((kit, ctx) => {
    const seen = new Set<string>()
    for (const q of kit.questions) {
      if (seen.has(q.id))
        ctx.addIssue({ code: "custom", message: `Duplicate question: ${q.id}` })
      if (q.when && !seen.has(q.when.question))
        ctx.addIssue({
          code: "custom",
          message: `Question conditions must reference an earlier question: ${q.when.question}`,
        })
      if (q.type === "select" || q.type === "multi-select") {
        const options = q.choices.map((c) => c.value)
        if (new Set(options).size !== options.length)
          ctx.addIssue({
            code: "custom",
            message: `Duplicate choice in ${q.id}`,
          })
        const defaults =
          q.type === "select" ? (q.default ? [q.default] : []) : q.default
        if (defaults.some((v) => !options.includes(v)))
          ctx.addIssue({
            code: "custom",
            message: `Invalid default in ${q.id}`,
          })
      }
      seen.add(q.id)
    }
    for (const output of kit.outputs) {
      if (output.when && !seen.has(output.when.question))
        ctx.addIssue({
          code: "custom",
          message: `Unknown question: ${output.when.question}`,
        })
    }
  })

export const catalogSchema = z
  .object({
    id,
    name: z.string().min(1),
    kits: z.array(
      z
        .object({
          id,
          name: z.string().min(1),
          source: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict()
  .refine(
    (catalog) =>
      new Set(catalog.kits.map((kit) => kit.id)).size === catalog.kits.length,
    "Kit IDs must be unique",
  )

export type Kit = z.infer<typeof kitSchema>
export type Question = Kit["questions"][number]
export type Condition = z.infer<typeof conditionSchema>
export type Answers = Record<string, string | boolean | string[]>
export type Scope = "repository" | "global" | "both" | "none"
export const catalogOriginSchema = z
  .object({
    catalogId: id.optional(),
    source: z.string().min(1),
    scope: z.enum(["repository", "global"]),
    repository: z.string().min(1).optional(),
    file: relativePath.optional(),
  })
  .strict()
  .refine(
    (origin) => origin.scope !== "repository" || !!origin.repository,
    "Repository origins require a repository",
  )
export type CatalogOrigin = z.infer<typeof catalogOriginSchema>
export interface ConfiguredKit {
  key: string
  kit: Kit
  answers: Answers
  origin?: CatalogOrigin
}
export interface LoadedKit {
  key: string
  kit: Kit
  origin?: CatalogOrigin
}
export interface Catalog {
  id: string
  name: string
  source: string
  permanent: boolean
  kits: LoadedKit[]
  kind?: "repo" | "builtin" | "external"
  automatic?: boolean
  unavailableKits?: {
    key?: string
    id?: string
    name: string
    source: string
    reason: string
  }[]
  issues?: string[]
}

export function matches(
  condition: Condition | undefined,
  answers: Answers,
): boolean {
  if (!condition) return true
  const answer = answers[condition.question]
  return condition.includes !== undefined
    ? Array.isArray(answer) && answer.includes(condition.includes)
    : answer === condition.equals
}

export function defaults(kit: Kit): Answers {
  return Object.fromEntries(
    kit.questions.map((q) => [
      q.id,
      q.type === "input"
        ? (q.default ?? "")
        : q.type === "select"
          ? (q.default ?? q.choices[0]!.value)
          : q.default,
    ]),
  )
}

/** Hidden answers cannot activate downstream questions or output previews. */
export function activeAnswers(kit: Kit, answers: Answers): Answers {
  const active: Answers = {}
  for (const question of kit.questions) {
    if (matches(question.when, active) && answers[question.id] !== undefined)
      active[question.id] = answers[question.id]!
  }
  return active
}

export function validateAnswers(kit: Kit, answers: Answers): Answers {
  const result: Answers = {}
  for (const q of kit.questions) {
    if (!matches(q.when, result)) continue
    const answer = answers[q.id]
    if (q.type === "input") {
      if (typeof answer !== "string" || (q.required && !answer.trim()))
        throw new Error(`${q.label}: enter a value`)
    } else if (q.type === "boolean") {
      if (typeof answer !== "boolean")
        throw new Error(`${q.label}: choose yes or no`)
    } else {
      const options = q.choices.map((c) => c.value)
      if (
        q.type === "select"
          ? typeof answer !== "string" || !options.includes(answer)
          : !Array.isArray(answer) || answer.some((v) => !options.includes(v))
      )
        throw new Error(`${q.label}: choose from the available options`)
    }
    result[q.id] = answer!
  }
  return result
}

export function interpolate(template: string, answers: Answers): string {
  return template.replace(/\{\{\s*([a-z0-9-]+)\s*\}\}/g, (_, key: string) => {
    const answer = answers[key]
    if (answer === undefined)
      throw new Error(`Template references unanswered question: ${key}`)
    return Array.isArray(answer) ? answer.join(", ") : String(answer)
  })
}
