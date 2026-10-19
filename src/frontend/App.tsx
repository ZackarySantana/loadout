import {
  createEffect,
  createMemo,
  createSignal,
  Index,
  onCleanup,
  Show,
} from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import { diffLines } from "diff"
import { activeAnswers, interpolate, matches } from "../domain/kit"
import { pages, ScreenModel, type Row } from "./model"

const color = {
  background: "#101a16",
  panel: "#17241e",
  text: "#e1eadc",
  muted: "#a1b49f",
  sage: "#bbd4a4",
  border: "#526c55",
  selected: "#344d38",
  warning: "#e0cb8e",
}
const safeText = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")

function details(
  model: ScreenModel,
  row?: Row,
): { title: string; body: string } {
  if (row?.catalog)
    return {
      title: row.catalog.name,
      body: `${row.catalog.description}\n\n${row.catalog.permanent ? "Built into Loadout. Always available." : row.catalog.source}\n\nKITS\n\n${row.catalog.kits.map(({ kit }) => `${kit.name}\n${kit.description}`).join("\n\n")}\n\nSpace to browse this catalog.`,
    }
  if (row?.item) {
    const { kit, key } = row.item
    const rawAnswers =
      model.form?.item.key === key
        ? model.form.answers
        : model.configuration(row.item).answers
    const answers = rawAnswers ? activeAnswers(kit, rawAnswers) : undefined
    const contributions = kit.outputs.map((output) => {
      const enabled = answers ? matches(output.when, answers) : true
      const content =
        output.type === "skill"
          ? Object.entries(output.files)
              .map(([name, text]) => `${name}\n${text}`)
              .join("\n\n")
          : output.content
      let preview = content
      if (answers) {
        try {
          preview = interpolate(content, answers)
        } catch {
          /* Show placeholders until required answers exist. */
        }
      }
      const destination =
        output.type === "instructions"
          ? output.targets.join(" + ")
          : output.type === "skill"
            ? `Skill: ${output.name}`
            : output.path
      return `${destination}${!enabled ? " (not included)" : output.when ? " (conditional)" : ""}\n${preview}`
    })
    return {
      title: kit.name,
      body: `${kit.description}\n\n${key}\nScope: ${model.form?.item.key === key ? model.form.scope : model.configuration(row.item).scope}\n\nCONTRIBUTIONS\n\n${contributions.join("\n\n────────────────\n\n")}\n\nBoth retains project intent while using only the global copy. Removing global restores all known project copies.`,
    }
  }
  if (row?.kind === "change" && model.plan && row.changeIndex !== undefined) {
    const change = model.plan.changes[row.changeIndex]!
    return {
      title: model.displayPath(change.path),
      body: diffLines(change.before ?? "", change.after ?? "")
        .map((part) =>
          part.value
            .split(/(?<=\n)/)
            .map(
              (line) =>
                `${part.added ? "+" : part.removed ? "−" : " "} ${line}`,
            )
            .join(""),
        )
        .join(""),
    }
  }
  if (model.page === 2)
    return {
      title: "Review before applying",
      body: `${model.plan?.summary.join("\n\n") ?? "No changes staged."}\n\nRepository\n${model.backend.repository}\n\nGlobal instructions\n~/.codex/AGENTS.md\n~/.claude/CLAUDE.md\n\nSkills\n.agents/skills + .claude/skills\n\nExisting text outside managed instruction blocks is preserved. Conflicting or externally edited files block the apply.\n\nChanges may include other known repositories when global scope changes.`,
    }
  return {
    title: model.page === 1 ? "Your installed kits" : "Build your loadout",
    body: "Compose agent context from catalogs of declarative kits.\n\n1. Open a catalog with Space.\n2. Configure kits inline.\n3. Tab to Review.\n4. Confirm to write files.\n\nRepository\nThis project only.\n\nGlobal\nAcross all your projects.\n\nBoth\nGlobal now, with project intent retained for automatic fallback.\n\nThe right column is informational. PgUp / PgDn scroll this preview.",
  }
}

export function App(props: { model: ScreenModel; onExit: () => void }) {
  const model = props.model
  const [revision, update] = createSignal(0)
  const [exitPrompt, setExitPrompt] = createSignal(false)
  const unsubscribe = model.subscribe(() => update((value) => value + 1))
  onCleanup(unsubscribe)
  const dimensions = useTerminalDimensions()
  // Reserve outer padding and the column gap before splitting available space.
  // Explicit widths keep the preview's intrinsic text width from shrinking the list.
  const columnWidth = createMemo(() => Math.max(0, dimensions().width - 3))
  const leftWidth = createMemo(() => Math.floor(columnWidth() * 0.7))
  const rows = createMemo(() => {
    revision()
    return model.rows()
  })
  const active = createMemo(() => {
    revision()
    return model.cursor
  })
  const preview = createMemo(() => {
    revision()
    return details(model, rows()[active()])
  })
  const editing = createMemo(() => {
    revision()
    return model.editing
  })
  const isEditing = (row: Row) => {
    const editor = editing()
    return (
      (row.kind === "input" &&
        editor?.kind === "question" &&
        editor.id === row.question?.id) ||
      (row.kind === "source" && editor?.kind === "catalog")
    )
  }
  const currentPage = createMemo(() => {
    revision()
    return model.page
  })
  const draftCount = createMemo(() => {
    revision()
    return model.drafts.size
  })
  const title = createMemo(() => {
    revision()
    return model.page === 0
      ? model.catalog
        ? `Catalogs / ${model.catalog.name}`
        : "Catalogs"
      : (pages[model.page] ?? "Loadout")
  })
  const status = createMemo(() => {
    revision()
    return exitPrompt()
      ? "Discard unapplied selections and exit?  Space exit · Esc stay"
      : `${model.busy ? "Working… " : ""}${safeText(model.message)}`
  })
  let list: ScrollBoxRenderable | undefined
  let info: ScrollBoxRenderable | undefined
  createEffect(() => {
    const id = rows()[active()]?.id
    if (id)
      queueMicrotask(() => {
        if (list && !list.isDestroyed) list.scrollChildIntoView(id)
      })
  })
  createEffect(() => {
    preview()
    info?.scrollTo(0)
  })
  const exit = () => {
    if (model.drafts.size || model.form) setExitPrompt(true)
    else props.onExit()
  }

  useKeyboard((key) => {
    if (key.eventType === "release") return
    if (model.busy) {
      key.preventDefault()
      return
    }
    if (exitPrompt()) {
      key.preventDefault()
      if (key.name === "space" || key.sequence === " ") props.onExit()
      else if (key.name === "escape") setExitPrompt(false)
      return
    }
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      exit()
      return
    }
    if (key.name === "escape") {
      key.preventDefault()
      model.back()
      return
    }
    if (key.name === "tab") {
      key.preventDefault()
      void model.cycle(key.shift)
      return
    }
    if (editing()) return
    key.preventDefault()
    if (key.name === "q") exit()
    else if (key.name === "up") model.move(-1)
    else if (key.name === "down") model.move(1)
    else if (
      key.name === "space" ||
      key.sequence === " " ||
      key.name === "return"
    )
      void model.activate()
    else if (key.name === "left") model.back()
    else if (key.name === "pageup")
      info?.scrollBy(-Math.max(1, dimensions().height - 8))
    else if (key.name === "pagedown")
      info?.scrollBy(Math.max(1, dimensions().height - 8))
  })

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={color.background}
      paddingX={1}
    >
      <box
        height={3}
        flexShrink={0}
        flexDirection="row"
        alignItems="center"
        gap={3}
      >
        <text fg={color.sage}>
          <b>LOADOUT</b>
        </text>
        <Index each={pages}>
          {(page, index) => (
            <text
              fg={currentPage() === index ? color.text : color.muted}
              bg={currentPage() === index ? color.selected : color.background}
            >
              {" "}
              {page()}{" "}
            </text>
          )}
        </Index>
        <Show when={draftCount() || dimensions().width >= 90}>
          <text fg={color.muted}>
            {draftCount()
              ? `${draftCount()} staged`
              : "agent context, composed"}
          </text>
        </Show>
      </box>
      <box flexGrow={1} minHeight={0} flexDirection="row" gap={1}>
        <box
          width={leftWidth()}
          minWidth={0}
          flexShrink={0}
          border
          borderStyle="rounded"
          borderColor={color.border}
          title={title()}
          backgroundColor={color.panel}
          flexDirection="column"
        >
          <scrollbox
            ref={list}
            flexGrow={1}
            minHeight={0}
            scrollX={false}
            contentOptions={{ flexDirection: "column", paddingX: 1 }}
          >
            <Show when={rows().length === 0}>
              <text fg={color.muted}>
                No kits yet. Tab to Catalogs to choose some.
              </text>
            </Show>
            <Index each={rows()}>
              {(row, index) => (
                <box
                  id={row().id}
                  flexDirection="column"
                  flexShrink={0}
                  paddingLeft={row().indent ? 2 : 0}
                  backgroundColor={
                    index === active() ? color.selected : color.panel
                  }
                >
                  <text
                    wrapMode="word"
                    flexShrink={0}
                    fg={
                      row().kind === "heading"
                        ? color.muted
                        : index === active()
                          ? color.sage
                          : color.text
                    }
                  >{`${index === active() ? "›" : " "} ${safeText(row().label)}`}</text>
                  <Show when={isEditing(row())}>
                    <input
                      focused
                      value={
                        row().kind === "source"
                          ? model.source
                          : String(
                              model.form?.answers[row().question!.id] ?? "",
                            )
                      }
                      onInput={(value) => model.edit(value)}
                      onSubmit={() => void model.finishInput()}
                      backgroundColor={color.selected}
                      textColor={color.text}
                      cursorColor={color.sage}
                      placeholder="Type here, Enter to finish"
                    />
                  </Show>
                </box>
              )}
            </Index>
          </scrollbox>
        </box>
        <box
          width={columnWidth() - leftWidth()}
          flexShrink={0}
          minWidth={0}
          border
          borderStyle="rounded"
          borderColor={color.border}
          title="Details"
          backgroundColor={color.panel}
          flexDirection="column"
          paddingX={1}
        >
          <text fg={color.sage} flexShrink={0}>
            {safeText(preview().title)}
          </text>
          <scrollbox
            ref={info}
            flexGrow={1}
            minHeight={0}
            scrollX={false}
            contentOptions={{ flexDirection: "column" }}
          >
            <text fg={color.text} wrapMode="word">
              {safeText(preview().body)}
            </text>
          </scrollbox>
        </box>
      </box>
      <text
        minHeight={2}
        wrapMode="word"
        flexShrink={0}
        fg={exitPrompt() ? color.warning : color.muted}
      >
        {status()}
      </text>
      <text wrapMode="word" flexShrink={0} fg={color.sage}>
        {editing()
          ? "Type an answer · Enter finish · Esc stop editing · Tab pages"
          : "↑↓ navigate · Space select · Tab pages · Esc back · PgUp/PgDn details · q quit"}
      </text>
    </box>
  )
}
