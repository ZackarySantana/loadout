import { createSignal, For, Show } from "solid-js"
import type { BoxRenderable } from "@opentui/core"
import type { Catalog, Kit } from "../domain/kit"
import { theme as color } from "./theme"
import { catalogCacheLabel, catalogKitCountLabel } from "./cache-label"
import { catalogUnavailableReason } from "./catalog-warnings"

const safeText = (text: string) =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")

function CatalogKit(props: { kit: Kit }) {
  const [width, setWidth] = createSignal(0)
  let section: BoxRenderable | undefined
  const name = () => safeText(props.kit.name)
  const wrappedTitle = () =>
    /[\r\n\t]/.test(name()) ||
    (width() > 0 && Bun.stringWidth(name()) > Math.max(0, width() - 4))
  return (
    <box
      ref={(ref: BoxRenderable) => {
        section = ref
        setWidth(ref.width)
      }}
      onSizeChange={() => setWidth(section?.width ?? 0)}
      width="100%"
      minWidth={0}
      flexDirection="column"
      flexShrink={0}
      border={["top"]}
      borderStyle="single"
      borderColor={color.border}
      title={wrappedTitle() ? undefined : name()}
      titleColor={color.sage}
      titleAlignment="center"
      paddingX={1}
    >
      <Show when={wrappedTitle()}>
        <text
          width="100%"
          minWidth={0}
          fg={color.sage}
          wrapMode="char"
          flexShrink={0}
        >
          {name()}
        </text>
      </Show>
      <text
        width="100%"
        minWidth={0}
        fg={color.text}
        wrapMode="word"
        flexShrink={0}
      >
        {safeText(props.kit.description) || "No description provided."}
      </text>
      <text width="100%" minWidth={0} wrapMode="word" flexShrink={0}>
        <For
          each={[...new Set(props.kit.outputs.map((output) => output.type))]}
        >
          {(type) => (
            <span style={{ fg: color[type === "agent" ? "skill" : type] }}>
              {
                {
                  instructions: "Instructions",
                  skill: "Skills",
                  file: "Files",
                  agent: "Agents",
                }[type]
              }{" "}
            </span>
          )}
        </For>
      </text>
    </box>
  )
}

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
      <text fg={color.muted} wrapMode="word" flexShrink={0}>
        {props.catalog.kind === "builtin"
          ? "Built into Loadout."
          : safeText(source())}
      </text>
      <Show when={props.catalog.kind !== "builtin"}>
        <text
          fg={props.catalog.kind === "repo" ? color.repository : color.global}
          wrapMode="word"
          flexShrink={0}
        >
          {props.catalog.kind === "remote"
            ? "Remote catalog"
            : props.catalog.kind === "repo"
              ? "Repo catalog"
              : "External catalog"}
        </text>
        <Show when={props.catalog.kind === "repo"}>
          <text fg={color.muted} wrapMode="word" flexShrink={0}>
            Kits from ./.loadout/kits
          </text>
        </Show>
      </Show>
      <Show when={props.catalog.cache}>
        {(cache) => (
          <box flexDirection="column" flexShrink={0}>
            <Show when={catalogCacheLabel(cache())}>
              {(label) => (
                <text fg={color.warning} wrapMode="word" flexShrink={0}>
                  {label()}
                </text>
              )}
            </Show>
            <Show when={cache().checkedAt}>
              <text fg={color.muted} wrapMode="word" flexShrink={0}>
                Checked · {safeText(cache().checkedAt)}
              </text>
            </Show>
            <Show when={cache().reason}>
              {(reason) => (
                <text fg={color.warning} wrapMode="word" flexShrink={0}>
                  {safeText(reason())}
                </text>
              )}
            </Show>
          </box>
        )}
      </Show>
      <text fg={color.sage} flexShrink={0}>
        {catalogKitCountLabel(props.catalog)}
      </text>
      <For each={props.catalog.kits}>
        {({ kit }) => <CatalogKit kit={kit} />}
      </For>
      <Show when={props.catalog.unavailableKits?.length}>
        <text fg={color.warning} flexShrink={0} wrapMode="word">
          UNAVAILABLE TO INSTALL/UPDATE
        </text>
        <text fg={color.muted} wrapMode="word" flexShrink={0}>
          Saved installations remain usable; these entries are currently
          unavailable.
        </text>
        <For each={props.catalog.unavailableKits}>
          {(kit) => (
            <box flexDirection="column" flexShrink={0} marginBottom={1}>
              <text fg={color.warning} wrapMode="word" flexShrink={0}>
                {safeText(kit.name)}
              </text>
              <text fg={color.muted} wrapMode="word" flexShrink={0}>
                {safeText(catalogUnavailableReason(props.catalog, kit))}
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}
