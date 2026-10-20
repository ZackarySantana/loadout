import { z } from "zod"

const location = z
  .string()
  .min(1)
  .refine(
    (value) => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value),
    "Locations must be nonempty paths without control characters",
  )
const group = z
  .object({
    locations: z.array(location),
    mode: z.enum(["copy", "link"]),
  })
  .strict()
  .refine(
    (value) => value.mode !== "link" || value.locations.length > 0,
    "Link mode requires a first location",
  )

export const outputSettingsSchema = z
  .object({
    repositoryInstructions: group,
    globalInstructions: group,
    repositorySkills: group,
    globalSkills: group,
  })
  .strict()

export type OutputSettings = z.infer<typeof outputSettingsSchema>
export type DestinationGroupKey = keyof OutputSettings
export const destinationGroups = [
  {
    key: "repositoryInstructions",
    label: "Repository instructions",
    scope: "repository",
    kind: "instructions",
  },
  {
    key: "globalInstructions",
    label: "Global instructions",
    scope: "global",
    kind: "instructions",
  },
  {
    key: "repositorySkills",
    label: "Repository skills",
    scope: "repository",
    kind: "skills",
  },
  {
    key: "globalSkills",
    label: "Global skills",
    scope: "global",
    kind: "skills",
  },
] as const satisfies readonly {
  key: DestinationGroupKey
  label: string
  scope: "repository" | "global"
  kind: "instructions" | "skills"
}[]
