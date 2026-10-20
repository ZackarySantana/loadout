import { isAbsolute, join, relative, resolve } from "node:path"
import {
  destinationGroups,
  outputSettingsSchema,
  type DestinationGroupKey,
  type OutputSettings,
} from "../domain/settings"

export function defaultOutputSettings(
  home: string,
  environment: Record<string, string | undefined>,
): OutputSettings {
  const codex = environment.CODEX_HOME || "~/.codex"
  const config = environment.XDG_CONFIG_HOME || "~/.config"
  return {
    repositoryInstructions: {
      locations: ["AGENTS.md", "CLAUDE.md"],
      mode: "copy",
    },
    globalInstructions: {
      locations: [
        join(codex, "AGENTS.md"),
        "~/.claude/CLAUDE.md",
        join(config, "opencode/AGENTS.md"),
      ],
      mode: "copy",
    },
    repositorySkills: {
      locations: [".agents/skills", ".claude/skills", ".opencode/skills"],
      mode: "copy",
    },
    globalSkills: {
      locations: [
        "~/.agents/skills",
        "~/.claude/skills",
        join(config, "opencode/skills"),
      ],
      mode: "copy",
    },
  }
}

export interface ResolvedDestinationGroup {
  key: DestinationGroupKey
  scope: "repository" | "global"
  kind: "instructions" | "skills"
  base: string
  locations: string[]
  mode: "copy" | "link"
}

export function resolveDestinations(
  settings: OutputSettings,
  home: string,
  repositories: string[],
): ResolvedDestinationGroup[] {
  settings = outputSettingsSchema.parse(settings)
  const result: ResolvedDestinationGroup[] = []
  for (const descriptor of destinationGroups) {
    const group = settings[descriptor.key]
    for (const base of descriptor.scope === "global"
      ? [home]
      : [...new Set(repositories)]) {
      const locations = [
        ...new Set(
          group.locations.map((value) => {
            if (value.includes("\\"))
              throw new Error("Use forward slashes in output locations")
            if (value.split("/").includes(".."))
              throw new Error(`Output location contains traversal: ${value}`)
            if (
              descriptor.scope === "repository" &&
              (isAbsolute(value) || value.startsWith("~"))
            )
              throw new Error(`Repository locations must be relative: ${value}`)
            if (value.startsWith("~") && !value.startsWith("~/"))
              throw new Error(`Use ~/ for home locations: ${value}`)
            const path = value.startsWith("~/")
              ? resolve(home, value.slice(2))
              : resolve(base, value)
            if (
              path === base ||
              path === home ||
              path
                .split("/")
                .some((part) => part === ".git" || part === ".loadout")
            )
              throw new Error(`Reserved output location: ${value}`)
            if (descriptor.scope === "repository" && !inside(base, path))
              throw new Error(`Output is outside repository: ${value}`)
            return path
          }),
        ),
      ]
      result.push({ ...descriptor, base, locations, mode: group.mode })
    }
  }
  const all = result.flatMap((group) =>
    group.locations.map((path) => ({ path, group })),
  )
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!,
        b = all[j]!
      if (a.path === b.path || inside(a.path, b.path) || inside(b.path, a.path))
        throw new Error(`Overlapping output locations: ${a.path} and ${b.path}`)
    }
  return result
}

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return (
    rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)
  )
}
