import {
  createEffect,
  createMemo,
  createSelector,
  createSignal,
  Index,
  onCleanup,
  Show,
} from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { ScrollBoxRenderable, InputRenderable } from "@opentui/core"
import { pages, ScreenModel, type Row } from "./model"
import { KitPreview } from "./KitPreview"
import { CatalogPreview } from "./CatalogPreview"
import { GuidePreview } from "./GuidePreview"
import { Brand } from "./Brand"
import { ReviewPreview } from "./ReviewPreview"
import { SettingsPreview } from "./SettingsPreview"
import { Walkthrough, walkthroughPages } from "./Walkthrough"
import { DriftPreview, SourceNotice, sourceLabels } from "./DriftPreview"
import { theme as color, scopeColor } from "./theme"
import type { Scope } from "../domain/kit"
import { canonical } from "../domain/content"
import { UpdatePreview } from "./UpdatePreview"
import { catalogCacheLabel } from "./cache-label"
import { catalogProgressText } from "./CatalogProgress"
const safeText = (text: string) =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
const rowDescription = (row: Row) =>
  row.kind === "scope" || row.id === "review-actions"
    ? row.choices?.[row.focusedOptionIndex ?? 0]?.description
    : (row.description ?? row.question?.description)

function details(model: ScreenModel, row?: Row): { title: string } {
  if (row?.kind === "health" || row?.kind === "drift-file")
    return { title: "Source and output status" }
  if (row?.catalog)
    return {
      title: row.catalog.name,
    }
  if (row?.item) return { title: row.item.kit.name }
  if (model.page === 2)
    return {
      title: "Review before applying",
    }
  if (model.page === 3) return { title: "Output settings" }
  return {
    title: model.page === 1 ? "Your installed kits" : "Build your loadout",
  }
}

export function App(props: {
  model: ScreenModel
  onExit: () => void
  walkthrough?: boolean
  onWalkthroughDismiss?: () => Promise<void>
}) {
  const model = props.model
  const [revision, update] = createSignal(0)
  const [exitPrompt, setExitPrompt] = createSignal(false)
  const [walkthrough, setWalkthrough] = createSignal(props.walkthrough ?? false)
  const [walkthroughPage, setWalkthroughPage] = createSignal(0)
  const [guideMessage, setGuideMessage] = createSignal("")
  const [savingGuidePreference, setSavingGuidePreference] = createSignal(false)
  const unsubscribe = model.subscribe(() => update((value) => value + 1))
  onCleanup(() => {
    unsubscribe()
    model.cancelCatalogRefresh()
  })
  const dimensions = useTerminalDimensions()
  const tabLines = createMemo(() => {
    if (dimensions().width >= 54) return 1
    const available = Math.max(1, dimensions().width - 4)
    let lines = 1
    let used = 0
    for (const page of pages) {
      const width = page.length + 2
      if (used && used + 1 + width > available) {
        lines++
        used = 0
      }
      used += (used ? 1 : 0) + width
    }
    return lines
  })
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
  const isActive = createSelector(active)
  const preview = createMemo(() => {
    revision()
    return details(model, rows()[active()])
  })
  const kitSelection = createMemo(
    () => {
      revision()
      const item = rows()[active()]?.item
      if (!item) return undefined
      const config = model.configuration(item)
      const form = model.form?.item.key === item.key ? model.form : undefined
      const answers = form?.answers ?? config.answers
      return {
        item,
        // Forms mutate their answer map in place. Keep a value snapshot so an
        // unchanged focus move is cheap without hiding real input edits.
        answers:
          answers &&
          Object.fromEntries(
            Object.entries(answers).map(([key, value]) => [
              key,
              Array.isArray(value) ? [...value] : value,
            ]),
          ),
        scope: form?.scope ?? config.scope,
      }
    },
    undefined,
    {
      equals: (before, after) =>
        before === after ||
        (!!before &&
          !!after &&
          before.item === after.item &&
          before.scope === after.scope &&
          canonical(before.answers) === canonical(after.answers)),
    },
  )
  const updateSelection = createMemo(() => {
    revision()
    const row = rows()[active()]
    if (row?.kind !== "update-offer" || !row.sourceDrift?.latest)
      return undefined
    const installed = model
      .installedKits()
      .find((item) => item.key === row.sourceDrift!.key)
    const draft = installed ? model.drafts.get(installed.key) : undefined
    const form =
      model.form?.item.key === installed?.key ? model.form : undefined
    const scope = form?.scope ?? draft?.scope ?? row.sourceDrift.scope
    const updateOnly = form
      ? form.originalScope === "both" && !form.scopeChanged
      : draft?.update === true
    return installed
      ? {
          installed,
          latest: row.sourceDrift.latest,
          scope,
          staged: row.updateStaged,
          removing: scope === "none",
          preservesFallback:
            scope === "both" && row.sourceDrift.scope === "both" && updateOnly,
        }
      : undefined
  })
  const catalogSelection = createMemo(() => rows()[active()]?.catalog)
  const driftSelection = createMemo(() => {
    revision()
    const row = rows()[active()]
    return row?.kind === "health" || row?.kind === "drift-file"
      ? { report: model.drift, errors: model.errors, file: row.fileDrift }
      : undefined
  })
  const sourceSelection = createMemo(() => {
    revision()
    const row = rows()[active()]
    if (!row?.item) return undefined
    const issue = model.sourceDrift(row.item.key)
    const staged = model.updateStaged(row.item.key)
    const form = model.form?.item.key === row.item.key ? model.form : undefined
    return issue && (issue.status !== "current" || staged)
      ? {
          issue,
          staged,
          installed: model
            .installedKits()
            .find((item) => item.key === row.item!.key),
          previewingLatest: form?.fromCatalog ?? row.fromCatalog,
        }
      : undefined
  })
  const emptyReviewSelection = {
    plan: undefined,
    selections: [],
    changeIndex: undefined,
    drift: undefined,
    errors: [],
    installed: [],
  }
  const reviewSelection = createMemo(() => {
    revision()
    if (model.page !== 2) return emptyReviewSelection
    return {
      plan: model.plan,
      selections: [...model.drafts.values()],
      changeIndex: rows()[active()]?.changeIndex,
      drift: model.drift,
      errors: model.errors,
      installed: model.installedKits(),
    }
  })
  const previewIdentity = createMemo(() => {
    const row = rows()[active()]
    if (row?.item) return `kit:${row.item.key}`
    if (row?.catalog) return `catalog:${row.catalog.id}`
    if (row?.kind === "change")
      return `change:${model.plan?.changes[row.changeIndex ?? -1]?.path ?? row.changeIndex}`
    if (row?.fileDrift) return `drift-file:${row.fileDrift.path}`
    if (row?.kind === "health") return "health"
    if (row?.kind === "update-offer") return row.id
    return `page:${model.page}`
  })
  const editing = createMemo(() => {
    revision()
    return model.editing
  })
  const formOpen = createMemo(() => {
    revision()
    return Boolean(model.form || model.settingsForm)
  })
  const [searchInput, setSearchInput] = createSignal<InputRenderable>()
  createEffect(() => {
    const input = searchInput()
    const locked = formOpen()
    if (input && !input.isDestroyed) input.focusable = !locked
  })
  const isEditing = (row: Row) => {
    const editor = editing()
    return (
      (row.kind === "input" &&
        editor?.kind === "question" &&
        editor.id === row.question?.id) ||
      (row.kind === "source" && editor?.kind === "catalog") ||
      (row.kind === "search" && editor?.kind === "search") ||
      (row.kind === "location-input" &&
        editor?.kind === "location" &&
        editor.id === row.locationId)
    )
  }
  const currentPage = createMemo(() => {
    revision()
    return model.page
  })
  const draftCount = createMemo(() => {
    revision()
    return model.stagedCount()
  })
  const settingsChanged = createMemo(() => {
    revision()
    return model.settingsChanged()
  })
  const title = createMemo(() => {
    revision()
    return model.page === 0
      ? model.catalog
        ? `Catalogs / ${model.catalog.name}${model.catalog.cache ? ` · ${catalogCacheLabel(model.catalog.cache)}` : ""}`
        : "Catalogs"
      : (pages[model.page] ?? "Loadout")
  })
  const status = createMemo(() => {
    revision()
    return exitPrompt()
      ? "Exit Loadout? Unapplied changes will be discarded.  q exit · Esc stay"
      : guideMessage()
        ? guideMessage()
        : walkthrough()
          ? "A quick tour. No kits, settings, or outputs are changed."
          : model.catalogProgress
            ? catalogProgressText(model.catalogProgress, dimensions().width - 2)
            : `${model.busy ? "Working… " : ""}${safeText(model.message)}`
  })
  const progressVisible = createMemo(() => {
    revision()
    return (
      !!model.catalogProgress &&
      !exitPrompt() &&
      !guideMessage() &&
      !walkthrough()
    )
  })
  let list: ScrollBoxRenderable | undefined
  let info: ScrollBoxRenderable | undefined
  let guideScroll: ScrollBoxRenderable | undefined
  const dismissWalkthrough = async () => {
    setWalkthrough(false)
    setGuideMessage("")
    if (!props.onWalkthroughDismiss || savingGuidePreference()) return
    setSavingGuidePreference(true)
    try {
      await props.onWalkthroughDismiss()
    } catch {
      setGuideMessage(
        "Guide closed; its preference could not be saved. It may appear next launch. Press ? to replay.",
      )
    } finally {
      setSavingGuidePreference(false)
    }
  }
  let previousQuestions = new Set<string>()
  let pendingReveal: { anchor: string; question: string } | undefined
  let scrollSelectionIntoView = () => {}
  createEffect(() => {
    const currentRows = rows()
    const row = currentRows[active()]
    const revealed =
      row?.kind === "input"
        ? currentRows
            .slice(active() + 1)
            .find(
              (candidate) =>
                candidate.question && !previousQuestions.has(candidate.id),
            )
        : undefined
    previousQuestions = new Set(
      currentRows
        .filter((candidate) => candidate.question)
        .map((candidate) => candidate.id),
    )
    if (revealed && row)
      pendingReveal = { anchor: row.id, question: revealed.id }
    if (pendingReveal?.anchor !== row?.id) pendingReveal = undefined
    if (row?.kind === "search") {
      // Search stays pinned above the list while results start at the top.
      scrollSelectionIntoView = () => {
        if (list && !list.isDestroyed) list.scrollTo(0)
      }
      scrollSelectionIntoView()
      return
    }
    const id = row?.choices
      ? `${row.id}:option:${row.focusedOptionIndex ?? 0}`
      : row?.kind === "input" ||
          row?.kind === "source" ||
          row?.kind === "location-input"
        ? `${row.id}:input`
        : row?.id
    dimensions()
    const revealedId = pendingReveal?.question
    scrollSelectionIntoView = () => {
      if (id) {
        if (!list || list.isDestroyed) return
        const labelId = row ? `${row.id}:label` : undefined
        if (labelId && list.findDescendantById(labelId))
          list.scrollChildIntoView(labelId)
        list.scrollChildIntoView(id)
        if (revealedId && list.findDescendantById(`${revealedId}:label`)) {
          list.scrollChildIntoView(`${revealedId}:label`)
          // The active control wins if the newly revealed question cannot fit too.
          list.scrollChildIntoView(id)
        }
      }
    }
    queueMicrotask(() => scrollSelectionIntoView())
  })
  createEffect(() => {
    // Keep the current contribution visible while its answers update live.
    // Reset only when navigating to a different kit, catalog, or changed file.
    previewIdentity()
    info?.scrollTo(0)
  })
  const exit = () => {
    model.cancelCatalogRefresh()
    setExitPrompt(true)
  }
  const rowColor = (row: Row, focused: boolean): string => {
    if (row.kind === "health" || row.kind === "drift-file") return color.warning
    if (row.kind === "update" || row.kind === "update-offer") return color.file
    if (row.kind === "heading") return color.muted
    if (row.kind === "register" || row.kind === "source") return color.file
    if (row.kind === "actions") return color.sage
    if (row.primary) return color.sage
    if (row.kind === "settings-group" && row.scope) return scopeColor(row.scope)
    if (row.kind === "change" && row.changeIndex !== undefined) {
      const change = model.plan?.changes[row.changeIndex]
      return change?.after === null
        ? color.removed
        : change?.before === null
          ? color.sage
          : color.file
    }
    return focused ? color.sage : color.text
  }

  useKeyboard((key) => {
    if (key.eventType === "release") return
    if (model.busy) {
      key.preventDefault()
      return
    }
    if (exitPrompt()) {
      key.preventDefault()
      if (key.name === "q" && !key.ctrl && !key.meta) props.onExit()
      else if (key.name === "escape") setExitPrompt(false)
      return
    }
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      exit()
      return
    }
    if (walkthrough()) {
      key.preventDefault()
      const motion = !key.ctrl && !key.meta && !key.shift ? key.name : undefined
      if (key.name === "q" && !key.ctrl && !key.meta) exit()
      else if (key.name === "escape") void dismissWalkthrough()
      else if (key.name === "left" || motion === "h")
        setWalkthroughPage((page) => Math.max(0, page - 1))
      else if (
        key.name === "right" ||
        motion === "l" ||
        key.name === "space" ||
        key.sequence === " " ||
        key.name === "return"
      ) {
        if (walkthroughPage() < walkthroughPages.length - 1)
          setWalkthroughPage((page) => page + 1)
        else if (key.name !== "right" && motion !== "l")
          void dismissWalkthrough()
      } else if (key.name === "up" || key.name === "pageup")
        guideScroll?.scrollBy(
          key.name === "up" ? -1 : -Math.max(1, dimensions().height - 10),
        )
      else if (key.name === "down" || key.name === "pagedown")
        guideScroll?.scrollBy(
          key.name === "down" ? 1 : Math.max(1, dimensions().height - 10),
        )
      return
    }
    // Never intercept a literal question mark in a text input. A non-text
    // form must be explicitly accepted/cancelled before opening the guide.
    if ((key.sequence === "?" || key.name === "?") && !editing()) {
      key.preventDefault()
      if (model.form || model.settingsForm || model.registering)
        setGuideMessage(
          "Accept or cancel the open form before replaying the walkthrough.",
        )
      else {
        setGuideMessage("")
        setWalkthroughPage(0)
        setWalkthrough(true)
      }
      return
    }
    setGuideMessage("")
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
    if (
      key.shift &&
      !key.ctrl &&
      !key.meta &&
      (key.name === "up" || key.name === "down")
    ) {
      key.preventDefault()
      info?.scrollBy(key.name === "up" ? -1 : 1)
      return
    }
    if (editing()) {
      if (key.name === "up" || key.name === "down") {
        key.preventDefault()
        model.move(key.name === "up" ? -1 : 1)
      }
      return
    }
    const motion = !key.ctrl && !key.meta && !key.shift ? key.name : undefined
    key.preventDefault()
    if (key.name === "q") exit()
    else if (
      (key.sequence === "/" || key.name === "/") &&
      currentPage() === 0 &&
      model.catalog
    )
      model.focusSearch()
    else if (key.name === "r") void model.refreshStatus()
    else if (key.name === "up" || motion === "k") model.move(-1)
    else if (key.name === "down" || motion === "j") model.move(1)
    else if (
      key.name === "space" ||
      key.sequence === " " ||
      key.name === "return"
    )
      void model.activate()
    else if (key.name === "left" || motion === "h") {
      if (model.selected()?.choices) model.moveOption(-1)
      else if (!model.form && !model.settingsForm) model.back()
    } else if (key.name === "right" || motion === "l") model.moveOption(1)
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
        id="loadout-header"
        height={dimensions().width < 54 ? 6 + tabLines() : 5}
        paddingX={1}
        paddingY={1}
        flexShrink={0}
        flexDirection={dimensions().width < 54 ? "column" : "row"}
        alignItems="center"
        gap={dimensions().width < 80 ? 1 : 3}
      >
        <Brand compact={dimensions().width < 82} />
        <box
          height={2 + tabLines()}
          flexGrow={1}
          minWidth={0}
          flexDirection="column"
          justifyContent="flex-start"
          paddingTop={1}
          width={dimensions().width < 54 ? "100%" : undefined}
        >
          <box
            id="loadout-tabs"
            height={tabLines()}
            flexShrink={0}
            flexDirection="row"
            flexWrap="wrap"
            columnGap={dimensions().width < 80 ? 1 : 3}
            rowGap={0}
          >
            <Index each={pages}>
              {(page, index) => (
                <text
                  flexShrink={0}
                  height={1}
                  fg={currentPage() === index ? color.text : color.muted}
                  bg={
                    currentPage() === index ? color.selected : color.background
                  }
                >
                  {" "}
                  {page()}{" "}
                </text>
              )}
            </Index>
          </box>
          <text
            id="loadout-caption"
            height={1}
            flexShrink={0}
            wrapMode="none"
            fg={draftCount() ? color.warning : color.muted}
          >
            {draftCount() ? `${draftCount()} staged` : ""}
          </text>
        </box>
      </box>
      <box flexGrow={1} minHeight={0} flexDirection="column">
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
            <Show when={rows()[0]?.kind === "search"}>
              <box
                id="catalog-search"
                width="100%"
                minWidth={0}
                flexDirection="column"
                flexShrink={0}
                paddingX={1}
                marginBottom={1}
                backgroundColor={isActive(0) ? color.selected : color.panel}
              >
                <text
                  fg={isActive(0) ? color.sage : color.text}
                  wrapMode="word"
                  flexShrink={0}
                >
                  {`${isActive(0) ? "›" : " "} Search kits `}
                  <span style={{ fg: color.muted }}>
                    {formOpen() ? "· kit locked" : "· / to focus"}
                  </span>
                </text>
                <box paddingLeft={2} flexShrink={0}>
                  <input
                    id="catalog-search:input"
                    ref={setSearchInput}
                    focused={!formOpen() && editing()?.kind === "search"}
                    width="100%"
                    value={rows()[0]?.value ?? ""}
                    onInput={(value) => {
                      if (!formOpen() && editing()?.kind === "search")
                        model.edit(value)
                    }}
                    onSubmit={() => {
                      if (!formOpen() && editing()?.kind === "search")
                        void model.finishInput()
                    }}
                    backgroundColor={isActive(0) ? color.selected : color.panel}
                    textColor={formOpen() ? color.muted : color.text}
                    cursorColor={color.sage}
                    placeholder="Name, ID, or description"
                  />
                </box>
                <text fg={color.muted} wrapMode="word" flexShrink={0}>
                  <i>{safeText(rows()[0]?.description ?? "")}</i>
                </text>
              </box>
            </Show>
            <scrollbox
              ref={list}
              flexGrow={1}
              minHeight={0}
              scrollX={false}
              contentOptions={{
                flexDirection: "column",
                paddingX: 1,
              }}
            >
              <Show when={rows().length === 0}>
                <text fg={color.muted}>
                  No kits yet. Tab to Catalogs to choose some.
                </text>
              </Show>
              <Index each={rows()}>
                {(row, index) => (
                  <Show when={row().kind !== "search"}>
                    <box
                      id={row().id}
                      flexDirection="column"
                      flexShrink={0}
                      paddingLeft={row().indent ? 2 : 0}
                      marginTop={
                        row().kind === "kit" ||
                        row().kind === "settings-group" ||
                        row().kind === "update-offer"
                          ? index > 0 &&
                            rows()[index - 1]?.kind !== "actions" &&
                            rows()[index - 1]?.kind !== "search"
                            ? 1
                            : 0
                          : row().kind === "location-input" ||
                              rows()[index - 1]?.id.endsWith(":add")
                            ? 0
                            : row().indent &&
                                (row().item ||
                                  row().settingsGroup ||
                                  model.settingsForm ||
                                  model.registering)
                              ? 1
                              : 0
                      }
                      marginBottom={row().kind === "actions" ? 1 : 0}
                      backgroundColor={
                        isActive(index) ? color.selected : color.panel
                      }
                    >
                      <Show when={row().label}>
                        <text
                          id={`${row().id}:label`}
                          wrapMode="word"
                          flexShrink={0}
                          fg={rowColor(row(), isActive(index))}
                        >
                          <Show
                            when={row().kind === "kit" && row().item}
                            fallback={`${isActive(index) ? "›" : " "} ${safeText(row().label)}`}
                          >
                            {(item) => (
                              <span>
                                {`${isActive(index) ? "›" : " "} ${row().scope === "none" ? "○" : "●"} ${safeText(item().kit.name)}  `}
                                <Show when={row().scope !== "none"}>
                                  <span
                                    style={{
                                      fg: scopeColor(row().scope ?? "none"),
                                    }}
                                  >{`[${row().scope}]`}</span>
                                </Show>
                                <Show when={row().staged}>
                                  <span style={{ fg: color.warning }}> *</span>
                                </Show>
                                <Show
                                  when={
                                    row().sourceDrift &&
                                    row().sourceDrift!.status !== "current"
                                  }
                                >
                                  <span
                                    style={{ fg: color.warning }}
                                  >{` · ${row().updateStaged ? "Update staged" : sourceLabels[row().sourceDrift!.status]}`}</span>
                                </Show>
                              </span>
                            )}
                          </Show>
                          <Show
                            when={
                              row().kind === "settings-group" && row().staged
                            }
                          >
                            <span style={{ fg: color.warning }}> *</span>
                          </Show>
                        </text>
                      </Show>
                      <Show
                        when={
                          row().kind === "kit" && row().item?.kit.description
                        }
                      >
                        {(description) => (
                          <box paddingLeft={4} flexShrink={0}>
                            <text
                              fg={color.muted}
                              wrapMode="word"
                              flexShrink={0}
                            >
                              <i>{safeText(description())}</i>
                            </text>
                          </box>
                        )}
                      </Show>
                      <Show when={row().kind === "location"}>
                        <box paddingLeft={2} flexShrink={0}>
                          <text fg={color.text} wrapMode="word" flexShrink={0}>
                            {safeText(row().value || "New location")}
                          </text>
                        </box>
                      </Show>
                      <Show
                        when={
                          row().choices &&
                          (row().kind !== "location" || isActive(index))
                        }
                      >
                        <box
                          flexDirection="row"
                          flexWrap="wrap"
                          paddingLeft={
                            row().kind === "actions" ||
                            row().kind === "location" ||
                            row().kind === "update-offer"
                              ? 0
                              : 2
                          }
                          gap={1}
                        >
                          <Index each={row().choices}>
                            {(choice, optionIndex) => (
                              <text
                                id={`${row().id}:option:${optionIndex}`}
                                flexShrink={0}
                                maxWidth="100%"
                                wrapMode="word"
                                bg={
                                  isActive(index) &&
                                  optionIndex === row().focusedOptionIndex
                                    ? color.optionFocus
                                    : isActive(index)
                                      ? color.selected
                                      : color.panel
                                }
                                fg={
                                  choice().disabled
                                    ? color.excluded
                                    : row().kind === "scope"
                                      ? scopeColor(choice().value as Scope)
                                      : row().kind === "actions" ||
                                          row().kind === "location" ||
                                          row().kind === "update-offer"
                                        ? choice().value === "accept" ||
                                          choice().value === "apply"
                                          ? color.sage
                                          : color.muted
                                        : choice().selected
                                          ? color.sage
                                          : color.text
                                }
                              >
                                {row().kind === "actions" ||
                                row().kind === "location" ||
                                row().kind === "update-offer"
                                  ? `${safeText(choice().label)}${choice().disabled ? " (unavailable)" : ""} `
                                  : ` ${
                                      row().question?.type === "multi-select"
                                        ? choice().selected
                                          ? "☑"
                                          : "☐"
                                        : choice().selected
                                          ? "◉"
                                          : "○"
                                    } ${safeText(choice().label)} `}
                              </text>
                            )}
                          </Index>
                        </box>
                      </Show>
                      <Show
                        when={
                          row().kind === "input" ||
                          row().kind === "source" ||
                          row().kind === "location-input"
                        }
                      >
                        <box paddingLeft={2} flexShrink={0}>
                          <input
                            id={`${row().id}:input`}
                            focused={isEditing(row())}
                            width="100%"
                            value={
                              row().kind === "source"
                                ? model.source
                                : row().kind === "location-input"
                                  ? (row().value ?? "")
                                  : String(
                                      model.form?.answers[row().question!.id] ??
                                        "",
                                    )
                            }
                            onInput={(value) => {
                              if (isEditing(row())) model.edit(value)
                            }}
                            onSubmit={() => void model.finishInput()}
                            backgroundColor={
                              isActive(index) ? color.selected : color.panel
                            }
                            textColor={color.text}
                            cursorColor={color.sage}
                            placeholder="Enter a value"
                          />
                        </box>
                      </Show>
                      <Show when={rowDescription(row())}>
                        {(description) => (
                          <box flexShrink={0}>
                            <text
                              id={
                                row().kind === "scope"
                                  ? "scope-description"
                                  : `${row().id}:description`
                              }
                              fg={color.muted}
                              wrapMode="word"
                              flexShrink={0}
                            >
                              <i>{safeText(description())}</i>
                            </text>
                          </box>
                        )}
                      </Show>
                    </box>
                  </Show>
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
            <Show when={!kitSelection()}>
              <text fg={color.sage} flexShrink={0}>
                {safeText(preview().title)}
              </text>
            </Show>
            <scrollbox
              ref={info}
              flexGrow={1}
              minHeight={0}
              scrollX={false}
              contentOptions={{ flexDirection: "column" }}
            >
              <Show
                when={updateSelection()}
                fallback={
                  <Show
                    when={kitSelection()}
                    fallback={
                      <Show
                        when={driftSelection()}
                        fallback={
                          <Show
                            when={catalogSelection()}
                            fallback={
                              <Show
                                when={currentPage() !== 3}
                                fallback={
                                  <SettingsPreview
                                    group={rows()[active()]?.settingsGroup}
                                    restoring={rows()[active()]?.id.startsWith(
                                      "settings:restore",
                                    )}
                                    staged={settingsChanged()}
                                  />
                                }
                              >
                                <Show
                                  when={currentPage() !== 2}
                                  fallback={
                                    <ReviewPreview
                                      plan={reviewSelection().plan}
                                      selections={reviewSelection().selections}
                                      changeIndex={
                                        reviewSelection().changeIndex
                                      }
                                      repository={model.backend.repository}
                                      home={model.backend.home}
                                      drift={reviewSelection().drift}
                                      errors={reviewSelection().errors}
                                      installed={reviewSelection().installed}
                                    />
                                  }
                                >
                                  <GuidePreview />
                                </Show>
                              </Show>
                            }
                          >
                            {(catalog) => (
                              <CatalogPreview
                                catalog={catalog()}
                                repository={model.backend.repository}
                              />
                            )}
                          </Show>
                        }
                      >
                        {(selection) => (
                          <DriftPreview
                            report={selection().report}
                            errors={selection().errors}
                            file={selection().file}
                          />
                        )}
                      </Show>
                    }
                  >
                    {(selection) => (
                      <box
                        width="100%"
                        minWidth={0}
                        flexDirection="column"
                        flexShrink={0}
                      >
                        <Show when={sourceSelection()}>
                          {(source) => (
                            <SourceNotice
                              issue={source().issue}
                              staged={source().staged}
                              previewingLatest={source().previewingLatest}
                              installed={source().installed}
                            />
                          )}
                        </Show>
                        <KitPreview
                          item={selection().item}
                          answers={selection().answers}
                          scope={selection().scope}
                        />
                      </box>
                    )}
                  </Show>
                }
              >
                {(selection) => <UpdatePreview {...selection()} />}
              </Show>
            </scrollbox>
          </box>
        </box>
        <Show when={walkthrough()}>
          <Walkthrough
            page={walkthroughPage}
            width={dimensions().width}
            scrollRef={(ref) => {
              guideScroll = ref
            }}
          />
        </Show>
      </box>
      <text
        height={progressVisible() ? 2 : undefined}
        minHeight={2}
        maxHeight={progressVisible() ? 2 : undefined}
        wrapMode="word"
        flexShrink={0}
        fg={exitPrompt() ? color.warning : color.muted}
      >
        {status()}
      </text>
      <text wrapMode="word" flexShrink={0} fg={color.sage}>
        {walkthrough()
          ? "Left/Right or h/l: Back/Next · Space/Enter: Next · Esc: Skip · ↑↓/PgUp/PgDn: scroll · q q quit"
          : editing()?.kind === "location"
            ? "Type a location · ↑↓ rows · Enter finish input · Esc accept group"
            : editing()?.kind === "search"
              ? "Type to filter kits · ↑↓ kits · Enter/Esc keep filter · Tab pages · Shift+↑↓ details"
              : editing()?.kind === "question"
                ? "Type an answer · ↑↓ questions · Enter finish input · Esc accept kit"
                : editing()?.kind === "catalog"
                  ? "Type an external catalog path or URL · Enter register · Esc stop editing"
                  : model.settingsForm
                    ? "↑↓/jk rows · ←→/hl actions · Space select · Esc accept group · Cancel discards"
                    : formOpen()
                      ? "↑↓/jk questions · ←→/hl options · Space select/toggle · Esc accept kit · Cancel discards"
                      : `${currentPage() === 0 && model.catalog ? "/ search · " : ""}↑↓/jk rows · ←→/hl options · Space select · Tab pages · ? walkthrough · r refresh · Esc back · Shift+↑↓/PgUp/PgDn details · q q quit`}
      </text>
    </box>
  )
}
