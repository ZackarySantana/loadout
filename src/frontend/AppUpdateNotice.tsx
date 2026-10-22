import type { ScrollBoxRenderable } from "@opentui/core"
import type { AppUpdateNotice } from "../domain/app-update"
import { For, Show } from "solid-js"
import {
  formatSelfUpdateCommand,
  type SelfUpdateSelection,
  type UpdateInstaller,
} from "../domain/self-update"
import { theme } from "./theme"

export type AppUpdateStep =
  | { kind: "notice" }
  | { kind: "discovering" }
  | { kind: "choose"; installers: UpdateInstaller[] }
  | { kind: "confirm"; selection: SelfUpdateSelection }
  | { kind: "pending" }
  | { kind: "manual"; reason: string }

/** Presentation only. No installer detection, filesystem access, or execution. */
export function AppUpdatePopup(props: {
  notice: AppUpdateNotice
  width: number
  height: number
  onLater: () => void
  onDismiss: () => void
  scrollRef: (ref: ScrollBoxRenderable) => void
  step?: AppUpdateStep
  choice?: number
  onUpdate?: () => void
  onChoose?: (installer: UpdateInstaller) => void
  onConfirm?: () => void
  onCancel?: () => void
}) {
  const step = () => props.step ?? { kind: "notice" as const }
  const cancel = () => (props.onCancel ?? props.onLater)()
  const actions = () => {
    const current = step()
    if (current.kind === "confirm")
      return [
        { label: "Cancel", run: cancel },
        { label: "Confirm update (y)", run: () => props.onConfirm?.() },
      ]
    if (current.kind === "choose")
      return [
        { label: "Cancel", run: cancel },
        ...current.installers.map((installer) => ({
          label: installer === "mise" ? "Mise" : "npm",
          run: () => props.onChoose?.(installer),
        })),
      ]
    if (current.kind === "notice")
      return [
        { label: "Later (Esc/Enter)", run: props.onLater },
        ...(props.onUpdate
          ? [{ label: "Update (u)", run: props.onUpdate }]
          : []),
        { label: "Don't remind this version (d)", run: props.onDismiss },
      ]
    return [{ label: "Cancel (Esc)", run: cancel }]
  }
  return (
    <box
      id="app-update-overlay"
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={100}
      backgroundColor="transparent"
      alignItems="center"
      justifyContent="center"
      onMouse={(event) => event.stopPropagation()}
    >
      <box
        id="app-update-popup"
        width={Math.min(74, Math.max(1, props.width - 4))}
        height={Math.min(22, Math.max(1, props.height - 2))}
        maxWidth="100%"
        maxHeight="100%"
        minWidth={0}
        minHeight={0}
        flexShrink={0}
        backgroundColor={theme.panel}
        border
        borderStyle="rounded"
        borderColor={theme.sage}
        title={
          step().kind === "confirm"
            ? "Confirm application update"
            : "Update available"
        }
        flexDirection="column"
        paddingX={1}
      >
        <scrollbox
          ref={props.scrollRef}
          flexGrow={1}
          minHeight={0}
          scrollX={false}
          contentOptions={{ flexDirection: "column", gap: 1 }}
        >
          <text fg={theme.sage} wrapMode="word" flexShrink={0}>
            {`Loadout ${props.notice.currentVersion} → ${props.notice.latestVersion}`}
          </text>
          <Show when={step().kind === "notice" || step().kind === "manual"}>
            <text fg={theme.muted} wrapMode="word" flexShrink={0}>
              A newer release is available. Choose Update to check which
              installer owns this installation, or run the appropriate command
              yourself after exiting Loadout.
            </text>
            <box flexDirection="column" flexShrink={0}>
              <text fg={theme.muted} wrapMode="word" flexShrink={0}>
                Mise
              </text>
              <text fg={theme.text} wrapMode="word" flexShrink={0}>
                {formatSelfUpdateCommand({
                  installer: "mise",
                  version: props.notice.latestVersion,
                })}
              </text>
              <text fg={theme.muted} wrapMode="word" flexShrink={0}>
                npm
              </text>
              <text fg={theme.text} wrapMode="word" flexShrink={0}>
                {formatSelfUpdateCommand({
                  installer: "npm",
                  version: props.notice.latestVersion,
                })}
              </text>
            </box>
            <text fg={theme.muted} wrapMode="word" flexShrink={0}>
              Read-only instructions. Nothing is run or copied for you.
            </text>
          </Show>
          <Show when={step().kind === "manual"}>
            <text fg={theme.warning} wrapMode="word" flexShrink={0}>
              {(step() as Extract<AppUpdateStep, { kind: "manual" }>).reason}
            </text>
          </Show>
          <Show
            when={step().kind === "discovering" || step().kind === "pending"}
          >
            <text fg={theme.muted} wrapMode="word" flexShrink={0}>
              {step().kind === "discovering"
                ? "Checking supported installer ownership… Nothing will be installed without separate confirmation."
                : "Waiting for the launcher to accept the update… Esc cancels."}
            </text>
          </Show>
          <Show when={step().kind === "choose"}>
            <text fg={theme.muted} wrapMode="word" flexShrink={0}>
              Choose a verified owner of this installation. The next step shows
              the exact command; nothing is installed yet.
            </text>
          </Show>
          <Show when={step().kind === "confirm"}>
            <text
              fg={theme.warning}
              wrapMode="word"
              flexShrink={0}
            >{`Update the global Loadout installation to ${props.notice.latestVersion}? Loadout will close before the installer runs, then restart in this repository. This changes the global application/tool selection, not kits or output settings. Installer failure may leave a changed installation; no rollback is promised. No credentials are requested here.`}</text>
            <text fg={theme.text} wrapMode="word" flexShrink={0}>
              {step().kind === "confirm"
                ? formatSelfUpdateCommand(
                    (step() as Extract<AppUpdateStep, { kind: "confirm" }>)
                      .selection,
                  )
                : ""}
            </text>
          </Show>
          <box flexDirection="row" flexWrap="wrap" gap={1} flexShrink={0}>
            <For each={actions()}>
              {(action, index) => (
                <text
                  fg={(props.choice ?? 0) === index() ? theme.sage : theme.text}
                  bg={
                    (props.choice ?? 0) === index()
                      ? theme.optionFocus
                      : theme.selected
                  }
                  wrapMode="word"
                  flexShrink={0}
                  maxWidth="100%"
                  onMouseDown={(event) => {
                    if (event.button !== 0) return
                    event.stopPropagation()
                    event.preventDefault()
                    action.run()
                  }}
                >
                  {` ${action.label} `}
                </text>
              )}
            </For>
          </box>
          <text fg={theme.muted} wrapMode="word" flexShrink={0}>
            {step().kind === "confirm"
              ? "Enter/Esc cancel · y confirm · ↑↓/jk/PgUp/PgDn scroll · q q quit"
              : "←→/hl/Tab choose · Enter activate · Esc cancel · ↑↓/jk/PgUp/PgDn scroll · q q quit"}
          </text>
        </scrollbox>
      </box>
    </box>
  )
}
