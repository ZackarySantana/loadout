import { z } from "zod"

const path = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !/[\\\x00-\x1f\x7f-\x9f\u2028\u2029\ud800-\udfff]/u.test(value) &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Use a control-free Unicode relative path without traversal",
  )
const id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .max(200)
const skillPath = z.union([path, z.literal(".")])
export const githubRepoSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/)
export const remoteRefSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      !/[\x00-\x20\x7f-\x9f\u2028\u2029\ud800-\udfff?#\\]/u.test(value) &&
      !value.split("/").some((part) => !part || part === "." || part === ".."),
    "Use a control-free Unicode ref without traversal, query, or fragment",
  )
export const remoteSkillsSourceSchema = z
  .object({
    type: z.literal("remote-skills"),
    id,
    name: z.string().min(1).max(200),
    repo: githubRepoSchema,
    ref: remoteRefSchema.optional(),
    directory: path.optional(),
    license: path.optional(),
    kits: z
      .array(
        z
          .object({
            id,
            name: z.string().min(1).max(200),
            skills: z
              .array(
                z
                  .object({ path: skillPath, license: path.optional() })
                  .strict(),
              )
              .min(1)
              .max(32),
          })
          .strict(),
      )
      .min(1)
      .max(500)
      .optional(),
  })
  .strict()
  .refine(
    (source) =>
      !source.kits ||
      new Set(source.kits.map((kit) => kit.id)).size === source.kits.length,
    "Remote kit IDs must be unique",
  )
export type RemoteSkillsSource = z.infer<typeof remoteSkillsSourceSchema>

export const remoteProvenanceSchema = z
  .object({
    repo: githubRepoSchema,
    ref: remoteRefSchema.optional(),
    directory: path.optional(),
    skillPaths: z.array(skillPath).min(1).max(32).optional(),
    commit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    upstreamCommitDate: z.string().datetime({ offset: true }).optional(),
    retrievedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
