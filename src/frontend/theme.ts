import type { Scope } from "../domain/kit"
import type { AgentHarness } from "../domain/subagents"

/** Shared semantic colors: the same meaning keeps its color across both panes. */
export const theme = {
  background: "#101a16",
  panel: "#17241e",
  text: "#e1eadc",
  muted: "#a1b49f",
  sage: "#bbd4a4",
  border: "#526c55",
  selected: "#344d38",
  optionFocus: "#526c55",
  warning: "#e3c58c",
  removed: "#df9a97",
  excluded: "#858b87",
  repository: "#98c7e6",
  global: "#e3c58c",
  both: "#c4ace0",
  instructions: "#bbd4a4",
  skill: "#c4ace0",
  file: "#98c7e6",
} as const

/** Muted harness identities, independent of contribution and installation scope. */
export const harnessColors = {
  codex: "#8fb8ac",
  claude: "#cea58c",
  opencode: "#a6aed0",
} as const satisfies Record<AgentHarness, string>

export const scopeColor = (scope: Scope): string =>
  scope === "none" ? theme.excluded : theme[scope]
