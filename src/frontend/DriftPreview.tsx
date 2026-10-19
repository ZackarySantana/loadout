import { For, Show, type JSX } from "solid-js"
import type {
  DriftReport,
  FileDrift,
  KitDrift,
  KitDriftStatus,
} from "../backend/service"
import { theme } from "./theme"

const safe = (text: string) =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
export const sourceLabels: Record<KitDriftStatus, string> = {
  current: "Source current",
  changed: "Source changed",
  "kit-missing": "Kit removed from catalog",
  "kit-unavailable": "Kit source unavailable",
  "catalog-unavailable": "Catalog unavailable",
  "subscription-missing": "Subscription missing",
  untracked: "Saved snapshot only",
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
          ? "The saved installation stays in effect until Review and Apply changes."
          : props.previewingLatest && props.issue.status === "changed"
            ? "This preview uses the current catalog definition. Accept the configuration, then Review and Apply to update installed files."
            : props.issue.status === "changed"
              ? "Installed files use the saved definition. Choose Use catalog update to review the current source, or keep configuring the snapshot."
              : `${safe(props.issue.reason)}. The saved kit is kept and can still be configured or removed.`}
      </text>
      <Show when={props.issue.origin}>
        <text fg={theme.muted} wrapMode="word" flexShrink={0}>
          {safe(props.issue.origin!.source)}
        </text>
      </Show>
    </box>
  )
}

export function DriftPreview(props: {
  report: DriftReport
  errors: string[]
  file?: FileDrift
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
            <Section title="Catalog definitions">
              <Show
                when={issues().length}
                fallback={
                  <text fg={theme.muted} wrapMode="word">
                    Saved kit definitions match their sources.
                  </text>
                }
              >
                <For each={issues()}>
                  {(kit) => (
                    <box flexDirection="column" flexShrink={0} marginBottom={1}>
                      <text fg={theme.warning} wrapMode="word" flexShrink={0}>
                        {safe(kit.key)} · {sourceLabels[kit.status]}
                      </text>
                      <text fg={theme.text} wrapMode="word" flexShrink={0}>
                        {safe(kit.reason)}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
              <text fg={theme.muted} wrapMode="word" flexShrink={0}>
                Missing or changed sources never uninstall kits. Configure the
                saved snapshot, or explicitly load an available catalog update.
              </text>
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
                  {(file) => (
                    <text fg={theme.warning} wrapMode="word" flexShrink={0}>
                      {file.status}: {safe(file.path)}
                    </text>
                  )}
                </For>
              </Show>
            </Section>
            <Show when={props.errors.length}>
              <Section title="Catalog warnings">
                <For each={props.errors}>
                  {(error) => (
                    <text fg={theme.warning} wrapMode="word" flexShrink={0}>
                      {safe(error)}
                    </text>
                  )}
                </For>
              </Section>
            </Show>
          </>
        }
      >
        {(file) => (
          <Section title="Managed output drift">
            <text fg={theme.file} wrapMode="word" flexShrink={0}>
              {safe(file().path)}
            </text>
            <text fg={theme.warning} wrapMode="word" flexShrink={0}>
              {file().status}
            </text>
            <text fg={theme.text} wrapMode="word" flexShrink={0}>
              {safe(file().reason)}
            </text>
          </Section>
        )}
      </Show>
      <Section title="Safe next steps">
        <text fg={theme.text} wrapMode="word" flexShrink={0}>
          Status does not repair or overwrite files. Modified or missing managed
          content blocks apply; restore or reconcile those files deliberately,
          then refresh.
        </text>
        <text fg={theme.muted} wrapMode="word" flexShrink={0}>
          User text outside managed instruction blocks is preserved. Catalog
          updates reuse compatible answers and still require Review and explicit
          Apply changes.
        </text>
      </Section>
    </box>
  )
}
