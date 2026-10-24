import { For, Show, type JSX } from "solid-js"
import type {
  DriftReport,
  FileDrift,
  KitDrift,
  KitDriftStatus,
} from "../backend/service"
import { theme } from "./theme"
import { displayKitKey } from "../domain/catalog"

const safe = (text: string) =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
export const sourceLabels: Record<KitDriftStatus, string> = {
  current: "Up to date",
  changed: "Update available",
  "kit-missing": "Removed from catalog",
  "kit-unavailable": "Update check failed",
  "catalog-unavailable": "Catalog unreachable",
  "subscription-missing": "Catalog removed",
  untracked: "Unknown catalog",
}

const keeps = "Your installed version keeps working."
const remove = "To remove it, press Enter and choose Not installed."

/** Plain next steps; raw reasons stay in `loadout status` for diagnosis. */
export function sourceGuidance(issue: KitDrift): string {
  switch (issue.status) {
    case "current":
      return "This kit matches its catalog."
    case "changed":
      return `${keeps} Press Enter to update it.`
    case "kit-missing":
      return `Its catalog no longer offers this kit. ${keeps} ${remove}`
    case "kit-unavailable":
      return `The catalog's copy of this kit could not be read, so updates are paused. ${keeps}`
    case "catalog-unavailable":
      return `Loadout could not reach this kit's catalog. ${keeps} Check your connection, then press r to retry.`
    case "subscription-missing":
      return issue.origin?.scope === "repository"
        ? `This kit came from an older Repo setup. ${keeps} Install it again from Repo to get updates.`
        : `This kit's catalog is no longer registered. ${keeps} Register ${safe(issue.origin?.source ?? "it")} again to get updates. ${remove}`
    case "untracked":
      return `Loadout does not know which catalog this kit came from, so it cannot check for updates. ${keeps}`
  }
}

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <box
      width="100%"
      minWidth={0}
      flexShrink={0}
      flexDirection="column"
      border={["top"]}
      borderStyle="single"
      borderColor={theme.border}
      title={props.title}
      titleColor={theme.warning}
      paddingX={1}
    >
      {props.children}
    </box>
  )
}

export function SourceNotice(props: {
  issue: KitDrift
  staged: boolean
  previewingLatest?: boolean
}) {
  return (
    <box
      width="100%"
      minWidth={0}
      flexDirection="column"
      flexShrink={0}
      marginBottom={1}
    >
      <text fg={theme.warning} wrapMode="word" flexShrink={0}>
        <b>
          {props.staged
            ? "Catalog update staged"
            : props.previewingLatest && props.issue.status === "changed"
              ? "Previewing catalog update"
              : sourceLabels[props.issue.status]}
        </b>
      </text>
      <text fg={theme.muted} wrapMode="word" flexShrink={0}>
        {props.staged
          ? "Nothing changes until you Review and Apply."
          : props.previewingLatest && props.issue.status === "changed"
            ? "Showing the new version. Accept, then Review and Apply to install it."
            : sourceGuidance(props.issue)}
      </text>
    </box>
  )
}

export function DriftPreview(props: {
  report: DriftReport
  errors: string[]
  file?: FileDrift
  scope?: "catalogs" | "installed" | "all"
}) {
  const issues = () =>
    props.report.kits.filter((kit) => kit.status !== "current")
  const files = () =>
    props.report.files.filter((file) => file.status !== "current")
  return (
    <box
      width="100%"
      minWidth={0}
      flexDirection="column"
      flexShrink={0}
      gap={1}
    >
      <Show
        when={props.file}
        fallback={
          <>
            <Show when={props.scope !== "catalogs"}>
              <Section title="Installed kits">
                <Show
                  when={issues().length}
                  fallback={
                    <text fg={theme.muted} wrapMode="word">
                      All installed kits are up to date.
                    </text>
                  }
                >
                  <For each={issues()}>
                    {(kit) => (
                      <box
                        flexDirection="column"
                        flexShrink={0}
                        marginBottom={1}
                      >
                        <text fg={theme.warning} wrapMode="word" flexShrink={0}>
                          {safe(displayKitKey(kit.key))} ·{" "}
                          {sourceLabels[kit.status]}
                        </text>
                        <text fg={theme.text} wrapMode="word" flexShrink={0}>
                          {sourceGuidance(kit)}
                        </text>
                      </box>
                    )}
                  </For>
                </Show>
              </Section>
              <Section title="Managed outputs">
                <Show
                  when={files().length}
                  fallback={
                    <text fg={theme.muted} wrapMode="word">
                      Managed output content matches its saved records.
                    </text>
                  }
                >
                  <For each={files()}>
                    {(file, index) => (
                      <text fg={theme.warning} wrapMode="word" flexShrink={0}>
                        Managed output {index() + 1}: {file.status}
                      </text>
                    )}
                  </For>
                </Show>
              </Section>
            </Show>
            <Show when={props.errors.length}>
              <Section title="Catalog availability">
                <For each={props.errors}>
                  {(error) => (
                    <text fg={theme.warning} wrapMode="word" flexShrink={0}>
                      {safe(error)}
                    </text>
                  )}
                </For>
                <Show when={props.scope === "catalogs"}>
                  <text fg={theme.muted} wrapMode="word" flexShrink={0}>
                    Catalog availability warnings do not mean managed output
                    files are modified. Open the affected catalog for entry
                    details.
                  </text>
                </Show>
              </Section>
            </Show>
          </>
        }
      >
        {(file) => (
          <Section title="Managed output drift">
            <text fg={theme.file} wrapMode="word" flexShrink={0}>
              Managed output · {file().status}
            </text>
            <text fg={theme.warning} wrapMode="word" flexShrink={0}>
              Open Review to inspect exact output locations.
            </text>
            <text fg={theme.text} wrapMode="word" flexShrink={0}>
              {file().status === "modified"
                ? "Managed content or its symbolic link differs from the saved record."
                : file().status === "missing"
                  ? "A managed output is missing."
                  : file().status === "unsafe"
                    ? "An output location contains an unexpected link or unsafe filesystem entry."
                    : "A managed output could not be read safely."}
            </text>
          </Section>
        )}
      </Show>
      <Show
        when={files().length || (props.file && props.file.status !== "current")}
      >
        <Section title="Safe next steps">
          <text fg={theme.text} wrapMode="word" flexShrink={0}>
            Status does not repair or overwrite files. Modified or missing
            managed content blocks apply; restore or reconcile those files
            deliberately, then refresh.
          </text>
          <text fg={theme.muted} wrapMode="word" flexShrink={0}>
            User text outside managed instruction blocks is preserved. Catalog
            updates reuse compatible answers and still require Review and
            explicit Apply changes.
          </text>
        </Section>
      </Show>
    </box>
  )
}
