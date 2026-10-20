import { createMemo, For, Show, type JSX } from "solid-js"
import { diffLines } from "diff"
import type { DriftReport, Plan, Selection } from "../backend/service"
import { sourceLabels } from "./DriftPreview"
import { scopeColor, theme } from "./theme"
import { displayKitKey } from "../domain/catalog"

const safeText = (text: string) =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")

export interface ReviewPreviewProps {
  plan?: Plan
  selections: readonly Selection[]
  repository: string
  home: string
  changeIndex?: number
  drift?: DriftReport
  errors?: string[]
}

function Section(props: {
  title: string
  accent?: string
  children: JSX.Element
}) {
  return (
    <box
      width="100%"
      minWidth={0}
      flexDirection="column"
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={theme.border}
      paddingX={1}
    >
      <text fg={props.accent ?? theme.sage} wrapMode="word" flexShrink={0}>
        <b>{props.title}</b>
      </text>
      {props.children}
    </box>
  )
}

/** Read-only review data: no filesystem work and no Markdown parsing. */
export function ReviewPreview(props: ReviewPreviewProps) {
  const change = createMemo(() =>
    props.changeIndex === undefined
      ? undefined
      : props.plan?.changes[props.changeIndex],
  )
  const counts = createMemo(() => {
    const changes = props.plan?.changes ?? []
    return {
      added: changes.filter((item) => item.before === null).length,
      removed: changes.filter((item) => item.after === null).length,
      modified: changes.filter(
        (item) => item.before !== null && item.after !== null,
      ).length,
    }
  })
  const diff = createMemo(() => {
    const item = change()
    return item
      ? diffLines(item.before ?? "", item.after ?? "").flatMap((part) =>
          part.value
            .split("\n")
            .filter(
              (line, index, lines) => index < lines.length - 1 || line !== "",
            )
            .map((line) => ({
              text: `${part.added ? "+" : part.removed ? "−" : " "} ${safeText(line)}`,
              color: part.added
                ? theme.sage
                : part.removed
                  ? theme.removed
                  : theme.muted,
            })),
        )
      : []
  })
  const path = (value: string) =>
    value.startsWith(`${props.repository}/`)
      ? `./${value.slice(props.repository.length + 1)}`
      : value.startsWith(`${props.home}/`)
        ? `~/${value.slice(props.home.length + 1)}`
        : value
  return (
    <box
      id="review-preview"
      width="100%"
      minWidth={0}
      flexDirection="column"
      flexShrink={0}
      gap={1}
    >
      <Show
        when={change()}
        fallback={
          <>
            <Section title="Staged selections">
              <Show
                when={props.selections.length}
                fallback={
                  <text fg={theme.muted} wrapMode="word">
                    No changes staged.
                  </text>
                }
              >
                <For each={props.selections}>
                  {(selection) => (
                    <box flexDirection="column" flexShrink={0} marginBottom={1}>
                      <text fg={theme.text} wrapMode="word" flexShrink={0}>
                        {safeText(selection.item.kit.name)}{" "}
                        <span
                          style={{ fg: scopeColor(selection.scope) }}
                        >{`[${selection.scope}]`}</span>
                      </text>
                      <For each={Object.entries(selection.answers)}>
                        {([key, value]) => (
                          <text fg={theme.muted} wrapMode="word" flexShrink={0}>
                            {safeText(
                              `${selection.item.kit.questions.find((question) => question.id === key)?.label ?? key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`,
                            )}
                          </text>
                        )}
                      </For>
                    </box>
                  )}
                </For>
              </Show>
              <For each={props.plan?.summary ?? []}>
                {(summary) => (
                  <text fg={theme.text} wrapMode="word" flexShrink={0}>
                    {safeText(summary)}
                  </text>
                )}
              </For>
            </Section>
            <Section title="File changes" accent={theme.file}>
              <text
                fg={theme.sage}
                wrapMode="word"
                flexShrink={0}
              >{`Added: ${counts().added}`}</text>
              <text
                fg={theme.file}
                wrapMode="word"
                flexShrink={0}
              >{`Modified: ${counts().modified}`}</text>
              <text
                fg={theme.removed}
                wrapMode="word"
                flexShrink={0}
              >{`Removed: ${counts().removed}`}</text>
              <Show when={props.plan && !props.plan.changes.length}>
                <text fg={theme.warning} wrapMode="word" flexShrink={0}>
                  No file changes. Apply still saves the staged installation
                  intent and answers.
                </text>
              </Show>
            </Section>
            <Section title="Locations" accent={theme.file}>
              <text fg={theme.repository} wrapMode="word" flexShrink={0}>
                Repository
              </text>
              <text fg={theme.text} wrapMode="word" flexShrink={0}>
                {safeText(props.repository)}
              </text>
              <text fg={theme.instructions} wrapMode="word" flexShrink={0}>
                Project: AGENTS.md + CLAUDE.md
              </text>
              <text fg={theme.global} wrapMode="word" flexShrink={0}>
                Global instructions
              </text>
              <text fg={theme.text} wrapMode="word" flexShrink={0}>
                {"~/.codex/AGENTS.md\n~/.claude/CLAUDE.md"}
              </text>
              <text fg={theme.skill} wrapMode="word" flexShrink={0}>
                Skills
              </text>
              <text fg={theme.text} wrapMode="word" flexShrink={0}>
                .agents/skills + .claude/skills
              </text>
            </Section>
            <Section title="Preservation & safety" accent={theme.warning}>
              <text fg={theme.text} wrapMode="word" flexShrink={0}>
                Existing text outside managed instruction blocks is preserved.
                Conflicting or externally edited files block the apply.
              </text>
              <text fg={theme.muted} wrapMode="word" flexShrink={0}>
                Changes may include other known repositories when global scope
                changes. Apply checks for concurrent state and file edits.
              </text>
            </Section>
          </>
        }
      >
        {(item) => (
          <>
            <Section title="File" accent={theme.file}>
              <text fg={theme.text} wrapMode="word" flexShrink={0}>
                {safeText(path(item().path))}
              </text>
              <text
                fg={
                  item().after === null
                    ? theme.removed
                    : item().before === null
                      ? theme.sage
                      : theme.file
                }
                wrapMode="word"
                flexShrink={0}
              >
                {item().after === null
                  ? "Removed"
                  : item().before === null
                    ? "Added"
                    : "Modified"}
              </text>
            </Section>
            <Section title="Diff">
              <For each={diff()}>
                {(line) => (
                  <text fg={line.color} wrapMode="word" flexShrink={0}>
                    {line.text}
                  </text>
                )}
              </For>
            </Section>
          </>
        )}
      </Show>
      <Show
        when={
          props.drift?.kits.some((kit) => kit.status !== "current") ||
          props.drift?.files.some((file) => file.status !== "current") ||
          props.errors?.length
        }
      >
        <Section title="Source and output status" accent={theme.warning}>
          <For
            each={props.drift?.kits.filter((kit) => kit.status !== "current")}
          >
            {(kit) => (
              <text fg={theme.warning} wrapMode="word" flexShrink={0}>
                {safeText(displayKitKey(kit.key))}: {sourceLabels[kit.status]}
              </text>
            )}
          </For>
          <For
            each={props.drift?.files.filter(
              (file) => file.status !== "current",
            )}
          >
            {(file) => (
              <text fg={theme.warning} wrapMode="word" flexShrink={0}>
                {file.status}: {safeText(file.path)}
              </text>
            )}
          </For>
          <For each={props.errors}>
            {(error) => (
              <text fg={theme.muted} wrapMode="word" flexShrink={0}>
                {safeText(error)}
              </text>
            )}
          </For>
          <text fg={theme.muted} wrapMode="word" flexShrink={0}>
            Drift is compared to the last applied snapshot. Staged catalog
            updates take effect only on Apply; missing sources never remove
            saved kits automatically.
          </text>
        </Section>
      </Show>
      <Section title="How to apply" accent={theme.warning}>
        <Show
          when={props.plan}
          fallback={
            <text fg={theme.muted} wrapMode="word" flexShrink={0}>
              Stage kits in Catalogs or Installed, then return to Review.
              Reviewing does not write any files.
            </text>
          }
        >
          <text fg={theme.text} wrapMode="word" flexShrink={0}>
            Reviewing does not write. Apply changes writes all listed files and
            saves installation intent, including changes in other known
            repositories.
          </text>
          <text fg={theme.sage} wrapMode="word" flexShrink={0}>
            Focus Apply changes with ←/→ or h/l, then press Space. This is the
            final confirmation; there is no second menu.
          </text>
          <text fg={theme.muted} wrapMode="word" flexShrink={0}>
            Keep editing is focused by default. Space returns to staged kits
            without writing. PgUp / PgDn scroll this preview.
          </text>
        </Show>
      </Section>
    </box>
  )
}
