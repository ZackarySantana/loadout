import { Show } from "solid-js"
import { destinationGroups, type DestinationGroupKey } from "../domain/settings"
import { scopeColor, theme } from "./theme"

export function SettingsPreview(props: {
  group?: DestinationGroupKey | "ignore"
  restoring?: boolean
  staged: boolean
}) {
  const descriptor = () =>
    destinationGroups.find((group) => group.key === props.group)
  return (
    <box
      width="100%"
      minWidth={0}
      flexDirection="column"
      flexShrink={0}
      gap={1}
    >
      <Show when={descriptor()}>
        {(group) => (
          <text fg={scopeColor(group().scope)} wrapMode="word" flexShrink={0}>
            {group().label}
          </text>
        )}
      </Show>
      <Show when={props.group === "ignore"}>
        <text fg={theme.repository} wrapMode="word" flexShrink={0}>
          Generated file ignores
        </text>
      </Show>
      <text fg={theme.text} wrapMode="word" flexShrink={0}>
        {props.restoring
          ? "Restore destination and ignore preferences. Accept stages defaults; it does not apply them."
          : props.group === "ignore"
            ? "This controls managed repository output files only. None adds no rules. Shared makes team-shared rules; Local uses Git private excludes."
            : "First location is canonical. Copy writes each location. Link makes managed files at later locations symbolic links to the first."}
      </text>
      <Show when={props.group === "ignore"}>
        <text fg={theme.warning} wrapMode="word" flexShrink={0}>
          Already tracked files stay tracked; nothing is untracked
          automatically.
        </text>
        <text fg={theme.muted} wrapMode="word" flexShrink={0}>
          Only generated rules are updated or removed. Existing user rules are
          preserved.
        </text>
      </Show>
      <Show when={!props.restoring && props.group !== "ignore"}>
        <text fg={theme.muted} wrapMode="word" flexShrink={0}>
          Only managed files are linked, not entire skill directories. Unrelated
          files stay untouched.
        </text>
        <text fg={theme.muted} wrapMode="word" flexShrink={0}>
          Reorder locations with Move up or Move down. Primary identifies the
          first location.
        </text>
      </Show>
      <text fg={theme.text} wrapMode="word" flexShrink={0}>
        Settings are shared across projects. Accept stages changes; Review and
        Apply saves them and updates managed outputs in known repositories.
      </text>
      <text fg={theme.muted} wrapMode="word" flexShrink={0}>
        Defaults support Codex, Claude, and OpenCode. Repository and global
        intent remain independent.
      </text>
      <Show when={props.staged}>
        <text fg={theme.warning} wrapMode="word" flexShrink={0}>
          Settings changes staged. Nothing written yet.
        </text>
      </Show>
    </box>
  )
}
