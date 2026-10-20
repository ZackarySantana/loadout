import { z } from "zod"
import { catalogOriginSchema, kitSchema } from "../domain/kit"
import { outputSettingsSchema } from "../domain/settings"

const answerSchema = z.record(
  z.string(),
  z.union([z.string(), z.boolean(), z.array(z.string())]),
)
const configuredSchema = z
  .object({
    key: z.string(),
    kit: kitSchema,
    answers: answerSchema,
    origin: catalogOriginSchema.optional(),
  })
  .strict()
const selectionSchema = z.record(z.string(), configuredSchema)
const managedSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("instructions"),
      blocks: z.record(z.string(), z.string()),
      originallyAbsent: z.boolean().optional(),
      layout: z
        .record(
          z.string(),
          z.object({ prefix: z.string(), suffix: z.string() }).strict(),
        )
        .optional(),
    })
    .strict(),
  z.object({ type: z.literal("file"), content: z.string() }).strict(),
  z
    .object({
      type: z.literal("symlink"),
      target: z.string().min(1),
      source: z.string().min(1),
    })
    .strict(),
])
export const stateSchema = z
  .object({
    catalogs: z.array(z.string()),
    global: selectionSchema,
    repositories: z.record(z.string(), selectionSchema),
    managed: z.record(z.string(), managedSchema),
    settings: outputSettingsSchema.optional(),
  })
  .strict()
export type State = z.infer<typeof stateSchema>
export type Managed = z.infer<typeof managedSchema>
export function emptyState(): State {
  return { catalogs: [], global: {}, repositories: {}, managed: {} }
}
