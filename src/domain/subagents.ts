import { z } from "zod"

export const agentHarnessSchema = z.enum(["codex", "claude", "opencode"])
export type AgentHarness = z.infer<typeof agentHarnessSchema>
const model = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s\x00-\x1f\x7f{}]+$/)

/** Native options are deliberately separate: models and tools are not portable. */
export const agentOptionsSchema = z
  .object({
    codex: z.object({ model: model.optional() }).strict().optional(),
    claude: z
      .object({
        model: model.optional(),
        tools: z
          .array(
            z.enum(["Read", "Grep", "Glob", "LSP", "WebFetch", "WebSearch"]),
          )
          .min(1)
          .optional(),
      })
      .strict()
      .optional(),
    opencode: z
      .object({
        model: model.regex(/^[^/]+\/[^/]+$/).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const agentFields = {
  name: z
    .string()
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z
    .string()
    .min(1)
    .refine(
      (value) => value.trim().length > 0,
      "Agent description must not be blank",
    ),
  instructions: z
    .string()
    .min(1)
    .refine(
      (value) => value.trim().length > 0,
      "Agent instructions must not be blank",
    ),
  harnesses: z
    .array(agentHarnessSchema)
    .min(1)
    .refine(
      (values) => new Set(values).size === values.length,
      "Agent harnesses must be unique",
    )
    .default(["codex", "claude", "opencode"]),
  options: agentOptionsSchema.optional(),
}
