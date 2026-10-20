import { dirname, join, relative } from "node:path"
import {
  interpolate,
  matches,
  validateAnswers,
  type ConfiguredKit,
} from "../domain/kit"
import type { OutputSettings } from "../domain/settings"
import type { State, Managed } from "./state"
import { defaultOutputSettings, inside, resolveDestinations } from "./settings"
import { agentPath, agentRoots, serializeAgent } from "./subagents"

export function renderState(
  state: State,
  home: string,
  settings: OutputSettings = state.settings ?? defaultOutputSettings(home, {}),
  repositoryOutputs?: Map<string, Set<string>>,
): State["managed"] {
  const result: State["managed"] = {}
  const groups = resolveDestinations(
    settings,
    home,
    Object.keys(state.repositories),
  )
  let repository: string | undefined
  const add = (path: string, output: Managed) => {
    if (repository && repositoryOutputs) {
      const paths = repositoryOutputs.get(repository) ?? new Set<string>()
      paths.add(path)
      repositoryOutputs.set(repository, paths)
    }
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
    repository = global ? undefined : root
    const answers = validateAnswers(config.kit, config.answers)
    const nativeRoots = agentRoots(settings, home, root, global)
    const destinations = (kind: "instructions" | "skills") =>
      groups.find(
        (group) =>
          group.base === root &&
          group.scope === (global ? "global" : "repository") &&
          group.kind === kind,
      )!
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
        // Legacy targets remain readable but no longer route generic instructions.
        const group = destinations("instructions")
        for (const path of group.mode === "link"
          ? group.locations.slice(0, 1)
          : group.locations)
          add(path, {
            type: "instructions",
            blocks: { [config.key]: text(output.content) },
          })
      } else if (output.type === "skill") {
        const group = destinations("skills")
        for (const location of group.mode === "link"
          ? group.locations.slice(0, 1)
          : group.locations)
          for (const [file, content] of Object.entries(output.files))
            add(join(location, output.name, file), {
              type: "file",
              // Adapted upstream resources are literal files, not Loadout templates.
              // They use exact-file management, so instruction-block markers are data too.
              content: config.origin?.remote ? content : text(content),
            })
      } else if (output.type === "agent") {
        for (const [harness, location] of Object.entries(nativeRoots)) {
          if (
            groups.some((group) =>
              group.locations.some(
                (path) =>
                  path === location ||
                  inside(path, location) ||
                  inside(location, path),
              ),
            ) ||
            Object.entries(nativeRoots).some(
              ([other, path]) =>
                other !== harness &&
                (path === location ||
                  inside(path, location) ||
                  inside(location, path)),
            )
          )
            throw new Error(`Overlapping native agent location: ${location}`)
        }
        for (const harness of output.harnesses)
          add(agentPath(nativeRoots[harness], output.name, harness), {
            type: "file",
            content: serializeAgent(output, harness, text),
          })
      } else {
        const path = join(root, output.path)
        if (
          output.path
            .split("/")
            .some((part) => [".git", ".loadout"].includes(part)) ||
          [
            "AGENTS.md",
            "CLAUDE.md",
            ".codex/AGENTS.md",
            ".claude/CLAUDE.md",
          ].includes(output.path) ||
          Object.values(nativeRoots).some(
            (location) =>
              path === location ||
              inside(location, path) ||
              inside(path, location),
          ) ||
          groups.some((group) =>
            group.locations.some(
              (location) =>
                path === location ||
                inside(path, location) ||
                (group.kind === "skills" && inside(location, path)),
            ),
          )
        )
          throw new Error(`Reserved output path: ${path}`)
        add(path, { type: "file", content: text(output.content) })
      }
    }
  }
  for (const config of Object.values(state.global)) render(config, home, true)
  for (const [repo, selections] of Object.entries(state.repositories))
    for (const config of Object.values(selections))
      if (!state.global[config.key]) render(config, repo, false)
  for (const group of groups) {
    repository = group.scope === "repository" ? group.base : undefined
    if (group.mode !== "link" || !group.locations.length) continue
    const primary = group.locations[0]!
    const sources = Object.keys(result).filter((path) =>
      group.kind === "instructions" ? path === primary : inside(primary, path),
    )
    for (const location of group.locations.slice(1))
      for (const source of sources) {
        const path =
          group.kind === "instructions"
            ? location
            : join(location, relative(primary, source))
        add(path, {
          type: "symlink",
          target: relative(dirname(path), source),
          source,
        })
      }
  }
  const paths = Object.keys(result)
  for (let i = 0; i < paths.length; i++)
    for (let j = i + 1; j < paths.length; j++)
      if (inside(paths[i]!, paths[j]!) || inside(paths[j]!, paths[i]!))
        throw new Error(
          `Output file/directory conflict: ${paths[i]} and ${paths[j]}`,
        )
  return result
}
