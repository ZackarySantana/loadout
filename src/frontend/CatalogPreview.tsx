import { For } from "solid-js"
import type { Catalog } from "../domain/kit"
import { theme as color } from "./theme"

const safeText = (text: string) =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")

/** Read-only catalog summary, with one visually distinct entry per kit. */
export function CatalogPreview(props: { catalog: Catalog }) {
  return (
    <box
      width="100%"
      minWidth={0}
      flexDirection="column"
      flexShrink={0}
      gap={1}
    >
      <text fg={color.text} wrapMode="word" flexShrink={0}>
        {safeText(props.catalog.description)}
      </text>
      <text fg={color.muted} wrapMode="word" flexShrink={0}>
        {props.catalog.permanent
          ? "Built into Loadout. Always available."
          : safeText(props.catalog.source)}
      </text>
      <text fg={color.sage} flexShrink={0}>
        KITS · {props.catalog.kits.length}
      </text>
      <For each={props.catalog.kits}>
        {({ kit }) => (
          <box
            width="100%"
            minWidth={0}
            flexDirection="column"
            flexShrink={0}
            border
            borderStyle="rounded"
            borderColor={color.border}
            paddingX={1}
          >
            <text fg={color.sage} wrapMode="word" flexShrink={0}>
              <b>{safeText(kit.name)}</b>
            </text>
            <text fg={color.text} wrapMode="word" flexShrink={0}>
              {safeText(kit.description) || "No description provided."}
            </text>
            <text wrapMode="word" flexShrink={0}>
              <For
                each={[...new Set(kit.outputs.map((output) => output.type))]}
              >
                {(type) => (
                  <span style={{ fg: color[type] }}>
                    {
                      {
                        instructions: "Instructions",
                        skill: "Skills",
                        file: "Files",
                      }[type]
                    }{" "}
                  </span>
                )}
              </For>
            </text>
          </box>
        )}
      </For>
      <text fg={color.muted} wrapMode="word" flexShrink={0}>
        Space to browse this catalog. PgUp / PgDn scroll the preview.
      </text>
    </box>
  )
}
