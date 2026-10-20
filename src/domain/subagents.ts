import { z } from "zod"

export const agentHarnessSchema = z.enum(["codex", "claude", "opencode"])
export type AgentHarness = z.infer<typeof agentHarnessSchema>
const model = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s\x00-\x1f\x7f{}]+$/)

export const codexFeatureKeys = [
  "shell_tool",
  "apps",
  "plugins",
  "memories",
  "request_permissions_tool",
] as const

const codexFeatures = z
  .object({
    shell_tool: z.literal(false).optional(),
    apps: z.literal(false).optional(),
    plugins: z.literal(false).optional(),
    memories: z.literal(false).optional(),
    request_permissions_tool: z.literal(false).optional(),
  })
  .strict()
  .refine(
    (features) => Object.values(features).some((value) => value === false),
    "Specify at least one capability to disable",
  )

const permissionText = z
  .string()
  .min(1)
  .refine(
    (value) => value.trim().length > 0,
    "Permission text must not be blank",
  )
  .refine(
    (value) => !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value),
    "Permission text must not contain controls or line breaks",
  )
  .refine(
    (value) => !/[\uD800-\uDFFF]/u.test(value),
    "Permission text must not contain unpaired Unicode surrogates",
  )

const opencodePermission = z
  .object({
    action: permissionText.max(256),
    resource: permissionText.max(4096),
    effect: z.enum(["allow", "ask", "deny"]),
  })
  .strict()

/** Native options are deliberately separate: models and tools are not portable. */
export const agentOptionsSchema = z
  .object({
    codex: z
      .object({ model: model.optional(), features: codexFeatures.optional() })
      .strict()
      .optional(),
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
        permissions: z.array(opencodePermission).min(1).max(128).optional(),
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
