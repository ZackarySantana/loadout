import { For, Show } from "solid-js"
import type { Catalog } from "../domain/kit"
import { scopeColor, theme as color } from "./theme"

const safeText = (text: string) =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")

/** Read-only catalog summary, with one visually distinct entry per kit. */
export function CatalogPreview(props: {
  catalog: Catalog
  repository?: string
}) {
  const source = () =>
    props.repository && props.catalog.source.startsWith(`${props.repository}/`)
      ? `./${props.catalog.source.slice(props.repository.length + 1)}`
      : props.catalog.source
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
        {props.catalog.permanent ? "Built into Loadout." : safeText(source())}
      </text>
      <Show when={!props.catalog.permanent}>
        <text
          fg={scopeColor(props.catalog.subscriptionScope ?? "global")}
          wrapMode="word"
          flexShrink={0}
        >
          {props.catalog.subscriptionScope === "both"
            ? "Repository + global catalog"
            : props.catalog.subscriptionScope === "repository"
              ? "Repository catalog"
              : "Global catalog"}
        </text>
        <Show when={props.catalog.automatic}>
          <text fg={color.muted} wrapMode="word" flexShrink={0}>
            Discovered from this project's .loadout/catalog.json.
          </text>
        </Show>
        <Show when={props.catalog.shared}>
          <text fg={color.muted} wrapMode="word" flexShrink={0}>
            Live subscription shared through .loadout/catalogs.json.
          </text>
        </Show>
      </Show>
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
      <Show when={props.catalog.unavailableKits?.length}>
        <text fg={color.warning} flexShrink={0}>
          UNAVAILABLE KITS
        </text>
        <For each={props.catalog.unavailableKits}>
          {(kit) => (
            <box flexDirection="column" flexShrink={0} marginBottom={1}>
              <text fg={color.warning} wrapMode="word" flexShrink={0}>
                {safeText(kit.name)}
              </text>
              <text fg={color.muted} wrapMode="word" flexShrink={0}>
                {safeText(kit.reason)}
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}
