import { For, Show } from "solid-js"
import type { LoadedKit, Scope } from "../domain/kit"
import { contentIdentity } from "../domain/content-identity"
import { scopeColor, theme } from "./theme"

const safe = (value: string) =>
  value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")

/** Provenance dates describe their actual event, never a guessed modification date. */
export function SourceMetadata(props: { item: LoadedKit; label: string }) {
  const dates = () => [
    ...(props.item.installedAt
      ? [`Installed · ${props.item.installedAt}`]
      : []),
    ...(props.item.origin?.remote?.upstreamCommitDate
      ? [`Upstream commit · ${props.item.origin.remote.upstreamCommitDate}`]
      : []),
    ...(props.item.origin?.remote?.retrievedAt
      ? [`Retrieved · ${props.item.origin.remote.retrievedAt}`]
      : []),
  ]
  return (
    <box width="100%" minWidth={0} flexDirection="column" flexShrink={0}>
      <text fg={theme.muted} wrapMode="word" flexShrink={0}>
        {safe(props.label)} · Content hash{" "}
        {contentIdentity(props.item).slice(0, 12)}
      </text>
      <For each={dates()}>
        {(date) => (
          <text fg={theme.muted} wrapMode="word" flexShrink={0}>
            {safe(date)}
          </text>
        )}
      </For>
    </box>
  )
}

export function UpdatePreview(props: {
  installed: LoadedKit
  latest: LoadedKit
  scope: Scope
  staged?: boolean
  removing?: boolean
  preservesFallback?: boolean
}) {
  return (
    <box
      width="100%"
      minWidth={0}
      flexDirection="column"
      flexShrink={0}
      gap={1}
    >
      <text fg={theme.warning} wrapMode="word" flexShrink={0}>
        Kit update · {safe(props.latest.kit.name)}{" "}
        <span style={{ fg: scopeColor(props.scope) }}>[{props.scope}]</span>
      </text>
      <text fg={theme.text} wrapMode="word" flexShrink={0}>
        {safe(props.latest.kit.description)}
      </text>
      <SourceMetadata item={props.installed} label="Installed" />
      <SourceMetadata item={props.latest} label="Available" />
      <Show when={props.latest.origin?.source}>
        <text fg={theme.muted} wrapMode="word" flexShrink={0}>
          {safe(props.latest.origin!.source)}
        </text>
      </Show>
      <text fg={theme.muted} wrapMode="word" flexShrink={0}>
        {props.removing
          ? "Removal staged; this update will not be installed."
          : props.staged
            ? "Update staged. Select file changes to inspect the actual diff before Apply."
            : "Keep installed is the default. Configure update reuses compatible answers; Accept stages the changes for review."}
      </text>
      <Show when={props.scope === "both" && props.preservesFallback}>
        <text fg={theme.muted} wrapMode="word" flexShrink={0}>
          Updates apply to the active installation; retained repository
          fallbacks keep their saved configuration.
        </text>
      </Show>
    </box>
  )
}
