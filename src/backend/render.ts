import { join } from "node:path"
import {
  interpolate,
  matches,
  validateAnswers,
  type ConfiguredKit,
} from "../domain/kit"
import type { State, Managed } from "./state"

export function renderState(state: State, home: string): State["managed"] {
  const result: State["managed"] = {}
  const add = (path: string, output: Managed) => {
    const existing = result[path]
    if (existing?.type === "instructions" && output.type === "instructions") {
      for (const [key, content] of Object.entries(output.blocks))
        existing.blocks[key] =
          existing.blocks[key] === undefined
            ? content
            : `${existing.blocks[key]}\n\n${content}`
    } else if (existing) throw new Error(`Multiple outputs write to ${path}`)
    else result[path] = output
  }
  const render = (config: ConfiguredKit, root: string, global: boolean) => {
    const answers = validateAnswers(config.kit, config.answers)
    for (const output of config.kit.outputs) {
      if (!matches(output.when, answers)) continue
      const text = (content: string) => {
        const rendered = interpolate(content, answers)
        if (/<!--\s*\/?loadout:/.test(rendered))
          throw new Error(
            "Kit content cannot contain Loadout management markers",
          )
        return rendered
      }
      if (output.type === "instructions") {
        for (const target of new Set(output.targets))
          add(
            join(
              root,
              global
                ? target === "AGENTS.md"
                  ? ".codex/AGENTS.md"
                  : ".claude/CLAUDE.md"
                : target,
            ),
            {
              type: "instructions",
              blocks: { [config.key]: text(output.content) },
            },
          )
      } else if (output.type === "skill") {
        for (const agent of [".agents", ".claude"])
          for (const [file, content] of Object.entries(output.files))
            add(join(root, agent, "skills", output.name, file), {
              type: "file",
              content: text(content),
            })
      } else {
        const path = output.path
        if (
          path.split("/").some((part) => [".git", ".loadout"].includes(part)) ||
          [
            "AGENTS.md",
            "CLAUDE.md",
            ".codex/AGENTS.md",
            ".claude/CLAUDE.md",
          ].includes(path)
        )
          throw new Error(`Reserved output path: ${path}`)
        add(join(root, path), { type: "file", content: text(output.content) })
      }
    }
  }
  for (const config of Object.values(state.global)) render(config, home, true)
  for (const [repo, selections] of Object.entries(state.repositories))
    for (const config of Object.values(selections))
      if (!state.global[config.key]) render(config, repo, false)
  return result
}
