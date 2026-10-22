import type { ScrollBoxRenderable } from "@opentui/core"
import type { AppUpdateNotice } from "../domain/app-update"
import { theme } from "./theme"

/** Read-only instructions: no installer detection, filesystem access, or execution. */
export function AppUpdatePopup(props: {
  notice: AppUpdateNotice
  width: number
  height: number
  onLater: () => void
  onDismiss: () => void
  scrollRef: (ref: ScrollBoxRenderable) => void
}) {
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
        height={Math.min(18, Math.max(1, props.height - 2))}
        maxWidth="100%"
        maxHeight="100%"
        minWidth={0}
        minHeight={0}
        flexShrink={0}
        backgroundColor={theme.panel}
        border
        borderStyle="rounded"
        borderColor={theme.sage}
        title="Update available"
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
          <text fg={theme.muted} wrapMode="word" flexShrink={0}>
            A newer release is available. Choose your installer and run its
            command yourself after exiting Loadout.
          </text>
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.muted} wrapMode="word" flexShrink={0}>
              Mise
            </text>
            <text fg={theme.text} wrapMode="word" flexShrink={0}>
              {`mise use -g 'npm:@lidtop/loadout@${props.notice.latestVersion}'`}
            </text>
            <text fg={theme.muted} wrapMode="word" flexShrink={0}>
              npm
            </text>
            <text fg={theme.text} wrapMode="word" flexShrink={0}>
              {`npm install --global '@lidtop/loadout@${props.notice.latestVersion}'`}
            </text>
          </box>
          <text fg={theme.muted} wrapMode="word" flexShrink={0}>
            Read-only instructions. Nothing is run or copied for you.
          </text>
          <box flexDirection="row" flexWrap="wrap" gap={1} flexShrink={0}>
            <text
              fg={theme.sage}
              bg={theme.selected}
              wrapMode="word"
              flexShrink={0}
              maxWidth="100%"
              onMouseDown={(event) => {
                if (event.button !== 0) return
                event.stopPropagation()
                event.preventDefault()
                props.onLater()
              }}
            >
              {" Later (Esc/Enter) "}
            </text>
            <text
              fg={theme.text}
              bg={theme.selected}
              wrapMode="word"
              flexShrink={0}
              maxWidth="100%"
              onMouseDown={(event) => {
                if (event.button !== 0) return
                event.stopPropagation()
                event.preventDefault()
                props.onDismiss()
              }}
            >
              {" Don't remind this version (d) "}
            </text>
          </box>
          <text fg={theme.muted} wrapMode="word" flexShrink={0}>
            ↑↓/jk/PgUp/PgDn scroll · q q quit
          </text>
        </scrollbox>
      </box>
    </box>
  )
}
