import { join, resolve } from "node:path"
import { stringify } from "yaml"
import type { Kit } from "../domain/kit"
import type { OutputSettings } from "../domain/settings"
import type { AgentHarness } from "../domain/subagents"

type Agent = Extract<Kit["outputs"][number], { type: "agent" }>

/** These are native discovery roots, not equivalent/cross-linkable formats. */
export function agentRoots(
  settings: OutputSettings,
  home: string,
  root: string,
  global: boolean,
): Record<AgentHarness, string> {
  const locations = global
    ? (settings.agentLocations ?? {
        codex: "~/.codex/agents",
        claude: "~/.claude/agents",
        opencode: "~/.config/opencode/agents",
      })
    : {
        codex: ".codex/agents",
        claude: ".claude/agents",
        opencode: ".opencode/agents",
      }
  return Object.fromEntries(
    Object.entries(locations).map(([harness, value]) => {
      if (
        value.includes("\\") ||
        value.split("/").includes("..") ||
        (value.startsWith("~") && !value.startsWith("~/"))
      )
        throw new Error(`Invalid native agent location: ${value}`)
      const path = value.startsWith("~/")
        ? resolve(home, value.slice(2))
        : resolve(root, value)
      if (
        path === home ||
        path === root ||
        path.split("/").some((part) => part === ".git" || part === ".loadout")
      )
        throw new Error(`Reserved native agent location: ${value}`)
      return [harness, path]
    }),
  ) as Record<AgentHarness, string>
}

/** TOML basic strings: escape every control rather than trusting kit/answer bytes. */
function tomlString(value: string): string {
  return `"${value.replace(/["\\\x00-\x1f\x7f]/g, (character) => {
    if (character === '"' || character === "\\") return `\\${character}`
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  })}"`
}

/** UTF-8 writes must preserve the exact strings stored in managed snapshots. */
function assertUnicodeScalars(
  value: string,
  agent: string,
  field: string,
): void {
  // Unicode mode consumes valid surrogate pairs as one astral code point;
  // only unpaired UTF-16 surrogates can match this range.
  if (/[\uD800-\uDFFF]/u.test(value))
    throw new Error(
      `Agent ${agent}: ${field} contains an unpaired Unicode surrogate; correct the kit text or answer`,
    )
}

export function serializeAgent(
  agent: Agent,
  harness: AgentHarness,
  text: (value: string) => string,
): string {
  const description = text(agent.description)
  const instructions = text(agent.instructions)
  assertUnicodeScalars(description, agent.name, "description")
  assertUnicodeScalars(instructions, agent.name, "instructions")
  for (const [target, options] of Object.entries(agent.options ?? {}))
    if (options.model !== undefined)
      assertUnicodeScalars(options.model, agent.name, `${target}.model`)
  if (!description.trim() || !instructions.trim())
    throw new Error(
      `Agent ${agent.name} requires nonempty description and instructions`,
    )
  if (harness === "codex") {
    return (
      [
        `name = ${tomlString(agent.name)}`,
        `description = ${tomlString(description)}`,
        ...(agent.options?.codex?.model
          ? [`model = ${tomlString(agent.options.codex.model)}`]
          : []),
        `developer_instructions = ${tomlString(instructions)}`,
      ].join("\n") + "\n"
    )
  }
  const metadata =
    harness === "claude"
      ? {
          name: agent.name,
          description,
          ...agent.options?.claude,
        }
      : {
          description,
          mode: "subagent",
          ...agent.options?.opencode,
        }
  return `---\n${stringify(metadata)}---\n\n${instructions}\n`
}

export function agentPath(
  root: string,
  name: string,
  harness: AgentHarness,
): string {
  return join(root, `${name}.${harness === "codex" ? "toml" : "md"}`)
}
