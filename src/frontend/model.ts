import {
  activeAnswers,
  matches,
  validateAnswers,
  type Answers,
  type Catalog,
  type LoadedKit,
  type Question,
  type Scope,
} from "../domain/kit"
import type { LoadoutService, Plan, Selection } from "../backend/service"
import type { DriftReport, FileDrift, KitDrift } from "../backend/service"
import { canonical } from "../domain/content"
import { sameSourceContent } from "../domain/content-identity"
import { catalogCacheLabel } from "./cache-label"
import type { CatalogFetchProgress } from "../domain/catalog-progress"
import { answersForUpdate } from "./answers"
import {
  destinationGroups,
  outputSettingsSchema,
  type OutputSettings,
  type DestinationGroupKey,
} from "../domain/settings"

export const pages = ["Catalogs", "Installed", "Review", "Settings"] as const
export type UISettingsKey = DestinationGroupKey | "ignore"
const settingsKeys: readonly UISettingsKey[] = [
  ...destinationGroups.map((group) => group.key),
  "ignore",
]
export interface RowChoice {
  value: string | boolean
  label: string
  selected: boolean
  description?: string
  disabled?: boolean
}
export interface Row {
  id: string
  label: string
  kind:
    | "catalog"
    | "kit"
    | "heading"
    | "scope"
    | "choice"
    | "input"
    | "search"
    | "actions"
    | "register"
    | "source"
    | "change"
    | "health"
    | "drift-file"
    | "update"
    | "update-offer"
    | "settings-group"
    | "location"
    | "location-input"
  indent?: boolean
  item?: LoadedKit
  scope?: Scope
  staged?: boolean
  catalog?: Catalog
  question?: Question
  choices?: RowChoice[]
  focusedOptionIndex?: number
  changeIndex?: number
  fromCatalog?: boolean
  sourceDrift?: KitDrift
  updateStaged?: boolean
  fileDrift?: FileDrift
  settingsGroup?: UISettingsKey
  locationId?: string
  description?: string
  value?: string
  primary?: boolean
}
interface Form {
  item: LoadedKit
  scope: Scope
  answers: Answers
  fromCatalog?: boolean
  reviewUpdate?: boolean
  originalScope?: Scope
  scopeChanged?: boolean
}
export type Backend = Pick<
  LoadoutService,
  | "repository"
  | "home"
  | "catalogs"
  | "installed"
  | "configuration"
  | "plan"
  | "apply"
  | "register"
  | "refresh"
  | "status"
  | "settings"
  | "defaultSettings"
  | "browseCatalog"
>

export class ScreenModel {
  page = 0
  cursor = 0
  catalog?: Catalog
  private browsedCatalog?: Catalog
  private catalogRefreshGeneration = 0
  private catalogRefreshAbort?: AbortController
  catalogProgress?: CatalogFetchProgress
  private pendingCatalogProgress?: CatalogFetchProgress
  private catalogProgressTimer?: ReturnType<typeof setTimeout>
  private catalogFilters = new Map<string, string>()
  catalogs: Catalog[] = []
  errors: string[] = []
  drift: DriftReport = { kits: [], files: [] }
  drafts = new Map<string, Selection>()
  private scopeChangedDrafts = new Set<string>()
  savedSettings?: OutputSettings
  defaultsSettings?: OutputSettings
  settingsDraft?: OutputSettings
  readonly stagedSettingsGroups = new Set<UISettingsKey>()
  settingsForm?: {
    group: UISettingsKey | "restore"
    locations: { id: string; value: string }[]
    mode: "copy" | "link"
    ignore: OutputSettings["ignore"]
    inputId?: string
  }
  private nextLocationId = 0
  form?: Form
  plan?: Plan
  busy = false
  message =
    "Space opens a catalog. Nothing is written until you review and apply."
  editing?:
    | { kind: "catalog" }
    | { kind: "search" }
    | { kind: "question"; id: string }
    | { kind: "location"; id: string }
  registering = false
  source = ""
  private optionFocus = new Map<string, number>()
  private listeners = new Set<() => void>()
  private installedSnapshot?: Map<string, LoadedKit>
  private installedView?: LoadedKit[]
  private kitRowCache = new Map<
    string,
    { row: Row; description: string; driftStatus?: KitDrift["status"] }
  >()

  constructor(readonly backend: Backend) {}
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private changed(): void {
    for (const listener of this.listeners) listener()
  }
  private installedItems(): Map<string, LoadedKit> {
    // installed() defensively clones every saved file. Share one snapshot across
    // row/selection reads, not one whole-inventory clone per visible kit.
    return (this.installedSnapshot ??= new Map(
      this.backend.installed().map((item) => [item.key, item]),
    ))
  }
  installedKits(): LoadedKit[] {
    // Keep exposed working definitions separate from the saved comparison base:
    // callers can mutate a row's kit without changing what counts as installed.
    this.installedView ??= structuredClone([...this.installedItems().values()])
    return [...this.installedView]
  }
  private async backendOperation<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } finally {
      // Status, browsing, planning and writes can reload concurrent intent, even
      // before failing. Never retain a snapshot across those service operations.
      this.installedSnapshot = undefined
      this.installedView = undefined
    }
  }
  async initialize(): Promise<void> {
    await this.loadStatus()
    this.message = this.issueCount()
      ? "Catalog or output drift found. Installed shows details; saved kits are kept."
      : "Choose a catalog."
    this.changed()
  }
  private async loadStatus(fresh = false): Promise<void> {
    const { catalogs, errors, drift } = await this.backendOperation(() =>
      this.backend.status({ fresh }),
    )
    this.catalogs = catalogs
    this.errors = errors
    this.drift = drift
    const previousSettings = this.settingsDraft ?? this.savedSettings
    this.savedSettings = this.backend.settings()
    const rebasedSettings = structuredClone(this.savedSettings)
    for (const group of this.stagedSettingsGroups) {
      if (
        !previousSettings ||
        canonical(previousSettings[group]) ===
          canonical(this.savedSettings[group])
      )
        this.stagedSettingsGroups.delete(group)
      else if (group === "ignore")
        rebasedSettings.ignore = previousSettings.ignore
      else rebasedSettings[group] = structuredClone(previousSettings[group])
    }
    this.settingsDraft = this.stagedSettingsGroups.size
      ? rebasedSettings
      : undefined
    this.defaultsSettings = this.backend.defaultSettings()
    if (this.catalog) {
      const current = catalogs.find(
        (catalog) =>
          catalog.id === this.catalog!.id &&
          catalog.source === this.catalog!.source,
      )
      const inventory = this.browsedCatalog
      if (
        current &&
        current.kind === "remote" &&
        current.hydration !== "loaded" &&
        inventory?.hydration === "loaded" &&
        inventory.id === current.id &&
        inventory.source === current.source
      ) {
        // Status intentionally inspects only installed remote kits. Its header is
        // not a replacement for a complete inventory explicitly browsed by the user.
        this.catalog = {
          ...current,
          kits: inventory.kits,
          hydration: current.issues?.length ? "partial" : "loaded",
          unavailableKits: [
            ...(inventory.unavailableKits ?? []),
            ...(current.unavailableKits ?? []),
          ],
          issues: [
            ...new Set([
              ...(current.issues?.length
                ? [
                    "Showing previously browsed inventory; source inspection reported issues.",
                  ]
                : []),
              ...(inventory.issues ?? []),
              ...(current.issues ?? []),
            ]),
          ],
        }
        this.catalogs = catalogs.map((catalog) =>
          catalog === current ? this.catalog! : catalog,
        )
      } else {
        this.catalog = current
        if (!current) this.browsedCatalog = undefined
        else if (current.hydration === "loaded") this.browsedCatalog = current
      }
    }
  }
  private showCatalog(catalog: Catalog): void {
    this.catalog = catalog
    this.browsedCatalog = catalog
    this.catalogs = this.catalogs.map((item) =>
      item.source === catalog.source && item.id === catalog.id ? catalog : item,
    )
  }
  cancelCatalogRefresh(): void {
    this.catalogRefreshGeneration++
    this.catalogRefreshAbort?.abort()
    this.catalogRefreshAbort = undefined
    this.clearCatalogProgress()
  }
  private clearCatalogProgress(): void {
    if (this.catalogProgressTimer !== undefined)
      clearTimeout(this.catalogProgressTimer)
    this.catalogProgressTimer = undefined
    this.pendingCatalogProgress = undefined
    this.catalogProgress = undefined
  }
  private startCatalogFetch(source: string) {
    this.cancelCatalogRefresh()
    const generation = this.catalogRefreshGeneration
    const controller = new AbortController()
    this.catalogRefreshAbort = controller
    const onProgress = (event: CatalogFetchProgress) => {
      if (
        generation !== this.catalogRefreshGeneration ||
        this.catalogRefreshAbort !== controller ||
        controller.signal.aborted ||
        event.source !== source
      )
        return
      if (event.stage === "complete") {
        const visible = !!this.catalogProgress
        this.clearCatalogProgress()
        if (visible) this.changed()
        return
      }
      this.pendingCatalogProgress = { ...event }
      if (this.catalogProgress) {
        this.catalogProgress = this.pendingCatalogProgress
        this.changed()
      } else if (this.catalogProgressTimer === undefined) {
        // Fast cache hits never paint a transient progress indicator.
        this.catalogProgressTimer = setTimeout(() => {
          this.catalogProgressTimer = undefined
          if (
            generation !== this.catalogRefreshGeneration ||
            controller.signal.aborted ||
            !this.pendingCatalogProgress
          )
            return
          this.catalogProgress = this.pendingCatalogProgress
          this.changed()
        }, 120)
      }
    }
    return { generation, controller, onProgress }
  }
  private finishCatalogFetch(
    controller: AbortController,
    generation: number,
  ): void {
    if (this.catalogRefreshAbort === controller)
      this.catalogRefreshAbort = undefined
    if (generation !== this.catalogRefreshGeneration) return
    const visible = !!this.catalogProgress
    this.clearCatalogProgress()
    if (visible) this.changed()
  }
  private async fetchCatalog(source: string, fresh = false): Promise<Catalog> {
    const { generation, controller, onProgress } =
      this.startCatalogFetch(source)
    try {
      return await this.backendOperation(() =>
        this.backend.browseCatalog(source, {
          fresh,
          signal: controller.signal,
          onProgress,
        }),
      )
    } finally {
      this.finishCatalogFetch(controller, generation)
    }
  }
  private async revalidateCatalog(catalog: Catalog): Promise<void> {
    const { generation, controller, onProgress } = this.startCatalogFetch(
      catalog.source,
    )
    const canReceive = () =>
      generation === this.catalogRefreshGeneration &&
      !controller.signal.aborted &&
      !this.busy &&
      !this.form &&
      !this.settingsForm &&
      !this.registering &&
      this.page === 0 &&
      this.catalog?.id === catalog.id &&
      this.catalog.source === catalog.source
    try {
      const result = await this.backendOperation(() =>
        this.backend.browseCatalog(catalog.source, {
          signal: controller.signal,
          onProgress,
        }),
      )
      if (
        !canReceive() ||
        result.id !== catalog.id ||
        result.source !== catalog.source
      )
        return
      const selection = this.selected()
      const selected = selection?.id
      const previous = new Map(
        this.catalog!.kits.map((item) => [item.key, item]),
      )
      const next = {
        ...result,
        kits: result.kits.map((item) => {
          const saved = previous.get(item.key)
          if (!saved || !sameSourceContent(saved, item)) return item
          return canonical(saved) === canonical(item)
            ? saved
            : { ...item, kit: saved.kit }
        }),
      }
      // A source change must not move a reader away from their selected kit.
      // The refreshed backend cache remains available on the next explicit browse.
      if (
        selection?.kind === "kit" &&
        !this.matchingKits(next).some(
          (item) => item.key === selection.item?.key,
        )
      )
        return
      this.showCatalog(next)
      const index = this.rows().findIndex((row) => row.id === selected)
      this.cursor =
        index >= 0
          ? index
          : Math.max(
              0,
              this.rows().findIndex((row) => row.kind === "kit"),
            )
      this.changed()
    } catch (error) {
      if (!canReceive()) return
      const current = this.catalog!
      const reason = error instanceof Error ? error.message : String(error)
      this.showCatalog(
        current.cache
          ? { ...current, cache: { ...current.cache, status: "stale", reason } }
          : {
              ...current,
              issues: [
                ...new Set([
                  ...(current.issues ?? []),
                  "Source check unavailable; previously browsed inventory retained.",
                ]),
              ],
            },
      )
      this.changed()
    } finally {
      this.finishCatalogFetch(controller, generation)
    }
  }
  private enterCatalog(catalog: Catalog): void {
    this.showCatalog(catalog)
    this.cursor = Math.max(
      0,
      this.rows().findIndex((row) => row.kind === "kit"),
    )
    if (!this.matchingKits().length) this.editing = { kind: "search" }
    this.message = "Space configures a kit. Esc returns to catalogs."
  }
  searchQuery(): string {
    return this.catalog
      ? (this.catalogFilters.get(
          canonical([this.catalog.source, this.catalog.id]),
        ) ?? "")
      : ""
  }
  private matchingKits(catalog = this.catalog): LoadedKit[] {
    const terms = this.searchQuery()
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
    if (!terms.length) return catalog?.kits ?? []
    return (catalog?.kits ?? []).filter((item) => {
      const text =
        `${item.kit.name} ${item.kit.id} ${item.key} ${item.kit.description}`.toLowerCase()
      return terms.every((term) => text.includes(term))
    })
  }
  focusSearch(): void {
    if (this.busy || this.page !== 0 || !this.catalog) return
    if (this.form || this.settingsForm || this.registering) {
      this.message = "Accept or cancel the open form before searching kits."
      this.changed()
      return
    }
    this.cursor = this.rows().findIndex((row) => row.id === "catalog-search")
    this.editing = { kind: "search" }
    this.message =
      "Filter by name, ID, or description · Enter/Esc keeps the filter · ↑↓ kits"
    this.changed()
  }
  issueCount(): number {
    return (
      this.errors.length +
      this.drift.kits.filter((kit) => kit.status !== "current").length +
      this.drift.files.filter((file) => file.status !== "current").length
    )
  }
  sourceDrift(key: string): KitDrift | undefined {
    return this.drift.kits.find((kit) => kit.key === key)
  }
  updateStaged(key: string): boolean {
    const draft = this.drafts.get(key)
    if (!draft || draft.scope === "none") return false
    const saved = this.installedItems().get(key)
    return (
      !!saved && draft.item !== saved && !sameSourceContent(draft.item, saved)
    )
  }
  canUpdate(item: LoadedKit): boolean {
    const latest = this.updateSource(item)
    return (
      !!latest &&
      item !== latest &&
      (!item.origin || item.origin.source === latest.origin?.source) &&
      !sameSourceContent(item, latest)
    )
  }
  private updateSource(item: LoadedKit): LoadedKit | undefined {
    const drift = this.sourceDrift(item.key)
    // An installed snapshot's drift report is authoritative, including missing sources.
    if (drift) return drift.latest
    const origin = item.origin
    if (
      !origin ||
      (origin.scope === "repository" &&
        origin.repository !== this.backend.repository)
    )
      return undefined
    // A concurrent uninstall removes the drift entry, not necessarily the source.
    // Never resolve a same-ID kit from a different catalog or repository instead.
    const latest = this.catalogs
      .find(
        (catalog) =>
          catalog.source === origin.source &&
          catalog.id === (origin.catalogId ?? item.key.split("/")[0]),
      )
      ?.kits.find((candidate) => candidate.key === item.key)
    return latest
  }
  updateOffers(): KitDrift[] {
    if (this.page === 2 && this.plan)
      return this.plan.updates.map((update) => ({
        key: update.key,
        scope: update.scope,
        origin: update.installed.origin,
        status: "changed",
        reason: "Source content differs from the installed snapshot.",
        latest: update.latest,
      }))
    return this.drift.kits.filter(
      (issue) =>
        issue.status === "changed" &&
        !!issue.latest &&
        this.installedItems().has(issue.key),
    )
  }
  private updateRows(): Row[] {
    const rows = this.updateOffers().flatMap((issue): Row[] => {
      const draft = this.drafts.get(issue.key)
      const staged = this.updateStaged(issue.key)
      const row: Row = {
        id: `update-offer:${issue.key}`,
        kind: "update-offer",
        label: `Kit update · ${issue.latest!.kit.name}`,
        sourceDrift: issue,
        updateStaged: staged,
        description:
          draft?.scope === "none"
            ? "Removal staged."
            : staged
              ? "Update staged. Review the file changes before applying."
              : "Keep the saved installation, or configure the available update.",
        choices: [
          { value: "keep", label: "Keep installed", selected: !staged },
          { value: "update", label: "Configure update", selected: staged },
        ],
        focusedOptionIndex:
          this.optionFocus.get(`update-offer:${issue.key}`) ?? 0,
      }
      return this.form?.reviewUpdate && this.form.item.key === issue.key
        ? [row, ...this.formRows(this.form)]
        : [row]
    })
    // Keep an open update form reachable even if its source becomes unavailable.
    if (
      this.form?.reviewUpdate &&
      !rows.some((row) => row.item?.key === this.form!.item.key)
    )
      rows.push(...this.formRows(this.form))
    return rows
  }
  async refreshStatus(): Promise<void> {
    if (this.busy) return
    if (this.form || this.settingsForm || this.registering) {
      this.message = "Accept or cancel the open form before refreshing sources."
      this.changed()
      return
    }
    const selected = this.selected()?.id
    const browsing =
      this.page === 0 && this.catalog?.kind === "remote"
        ? this.catalog.source
        : undefined
    await this.run(async () => {
      await this.loadStatus(true)
      this.plan = undefined
      this.optionFocus.delete("review-actions")
      if (browsing && this.catalog?.source === browsing) {
        try {
          this.showCatalog(await this.fetchCatalog(browsing, true))
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          const warning = `Source refresh failed; showing previously browsed inventory. ${reason}`
          this.catalog = {
            ...this.catalog,
            hydration: "partial",
            issues: [...new Set([...(this.catalog.issues ?? []), warning])],
          }
          if (this.browsedCatalog?.hydration === "loaded")
            this.browsedCatalog = {
              ...this.browsedCatalog,
              issues: this.catalog.issues,
            }
          this.catalogs = this.catalogs.map((catalog) =>
            catalog.source === browsing ? this.catalog! : catalog,
          )
          this.errors.push(`${browsing}: ${reason}`)
          throw error
        }
      }
      if (
        this.page === 2 &&
        (this.stagedCount() || this.updateOffers().length)
      ) {
        this.plan = await this.backendOperation(() =>
          this.backend.plan([...this.drafts.values()], this.settingsDraft),
        )
      }
      this.cursor = Math.max(
        0,
        this.rows().findIndex((row) => row.id === selected),
      )
      this.message = this.issueCount()
        ? "Source or output drift found. Installed shows details. No files changed."
        : "Catalogs and managed files checked. No drift detected."
    })
  }

  configuration(item: LoadedKit): { scope: Scope; answers?: Answers } {
    const draft = this.drafts.get(item.key)
    return draft
      ? { scope: draft.scope, answers: draft.answers }
      : this.backend.configuration(item.key)
  }
  private kitRows(items: LoadedKit[], fromCatalog = false): Row[] {
    const rows: Row[] = []
    const nextCache: typeof this.kitRowCache = new Map()
    const inventory = new Map(items.map((item) => [item.key, item]))
    // Keep the working copy visible even if status removes/replaces its source
    // or installation. Only Accept or explicit Cancel ends the form's lifetime.
    if (this.form) inventory.set(this.form.item.key, this.form.item)
    for (const item of inventory.values()) {
      const config = this.configuration(item)
      const id = `kit:${item.key}`
      const staged = this.drafts.has(item.key)
      const label = `${config.scope === "none" ? "○" : "●"} ${item.kit.name}  ${config.scope === "none" ? "" : `[${config.scope}]`}${staged ? " *" : ""}`
      const rowFromCatalog =
        this.form?.item.key === item.key ? this.form.fromCatalog : fromCatalog
      const sourceDrift = this.sourceDrift(item.key)
      const updateStaged = this.updateStaged(item.key)
      const cached = this.kitRowCache.get(id)
      const previous = cached?.row
      if (
        previous &&
        previous.item === item &&
        previous.scope === config.scope &&
        previous.label === label &&
        previous.staged === staged &&
        previous.fromCatalog === rowFromCatalog &&
        previous.sourceDrift === sourceDrift &&
        previous.updateStaged === updateStaged &&
        cached.description === item.kit.description &&
        cached.driftStatus === sourceDrift?.status
      ) {
        nextCache.set(id, cached)
        rows.push(previous)
      } else {
        const row: Row = {
          id,
          kind: "kit",
          label,
          item,
          scope: config.scope,
          staged,
          fromCatalog: rowFromCatalog,
          sourceDrift,
          updateStaged,
        }
        nextCache.set(id, {
          row,
          description: item.kit.description,
          driftStatus: sourceDrift?.status,
        })
        rows.push(row)
      }
      if (this.form?.item.key === item.key)
        rows.push(...this.formRows(this.form))
    }
    // Bound retained definitions to this list, including any locked working form.
    this.kitRowCache = nextCache
    return rows
  }
  private formRows(form: Form): Row[] {
    const visible = activeAnswers(form.item.kit, form.answers)
    const scopeChoices: RowChoice[] = [
      {
        value: "repository",
        label: "Repository",
        description:
          "This project only. Removes global intent; restores retained repository copies.",
      },
      {
        value: "global",
        label: "Global",
        description:
          "All projects. No fallback retained for this project; other projects keep their intent.",
      },
      {
        value: "both",
        label: "Both",
        description:
          "Global now; retain this project's intent for automatic repository fallback.",
      },
      {
        value: "none",
        label: "Not installed",
        description:
          "Clear global and this project's intent; restore other projects' retained copies.",
      },
    ].map((choice) => ({ ...choice, selected: choice.value === form.scope }))
    const rows: Row[] = [
      {
        id: "scope",
        kind: "scope",
        label: "Install where?",
        choices: scopeChoices,
        focusedOptionIndex:
          this.optionFocus.get("scope") ??
          scopeChoices.findIndex((choice) => choice.selected),
        indent: true,
        item: form.item,
      },
    ]
    if (form.scope !== "none" && this.canUpdate(form.item))
      rows.push({
        id: `update:${form.item.key}`,
        kind: "update",
        label: "Use catalog update",
        indent: true,
        item: form.item,
      })
    if (form.scope !== "none")
      for (const question of form.item.kit.questions) {
        if (!matches(question.when, visible)) continue
        const answer = form.answers[question.id]
        if (question.type === "input") {
          rows.push({
            id: `question:${question.id}`,
            kind: "input",
            label: question.label,
            question,
            indent: true,
            item: form.item,
          })
        } else {
          const choices =
            question.type === "boolean"
              ? [
                  { value: true, label: "Yes" },
                  { value: false, label: "No" },
                ]
              : question.choices
          const options = choices.map((choice): RowChoice => ({
            ...choice,
            selected: Array.isArray(answer)
              ? answer.includes(String(choice.value))
              : answer === choice.value,
          }))
          const id = `question:${question.id}`
          rows.push({
            id,
            kind: "choice",
            label: `${question.label}${question.type === "multi-select" ? " (choose any)" : ""}`,
            question,
            choices: options,
            focusedOptionIndex:
              this.optionFocus.get(id) ??
              Math.max(
                0,
                options.findIndex((choice) => choice.selected),
              ),
            indent: true,
            item: form.item,
          })
        }
      }
    rows.push({
      id: "actions",
      kind: "actions",
      label: "",
      choices: [
        { value: "accept", label: "Accept", selected: false },
        { value: "cancel", label: "Cancel", selected: false },
      ],
      focusedOptionIndex: this.optionFocus.get("actions") ?? 0,
      indent: true,
      item: form.item,
    })
    return rows
  }

  rows(): Row[] {
    if (this.page !== 1 && !(this.page === 0 && (this.catalog || this.form)))
      this.kitRowCache.clear()
    if (this.page === 0) {
      if (this.catalog) {
        const matches = this.matchingKits()
        const search: Row = {
          id: "catalog-search",
          kind: "search",
          label: "Search kits · / to focus",
          value: this.searchQuery(),
          description:
            this.catalog.hydration === "deferred" ||
            this.catalog.hydration === "partial"
              ? `${matches.length} matching available kits`
              : `Matches ${matches.length} of ${this.catalog.kits.length} kits`,
          catalog: this.catalog,
        }
        const rows: Row[] = [
          search,
          ...(this.catalog.issues ?? []).map((issue, index): Row => ({
            id: `catalog-issue:${this.catalog!.id}:${index}`,
            kind: "heading",
            label: `! ${issue}`,
            catalog: this.catalog,
          })),
          ...this.kitRows(matches, true),
          ...(this.catalog.unavailableKits ?? []).map((kit, index): Row => ({
            id: `unavailable:${this.catalog!.id}:${index}`,
            kind: "heading",
            label: `! ${kit.name}: ${kit.reason}`,
            catalog: this.catalog,
          })),
        ]
        if (!matches.length && !this.form)
          rows.push({
            id: "empty-catalog",
            kind: "heading",
            label: this.searchQuery().trim()
              ? "No matching kits. Edit or clear the search to show more."
              : "This catalog has no available kits. Saved installations remain in Installed.",
            catalog: this.catalog,
          })
        return rows
      }
      if (this.form) return this.kitRows([], this.form.fromCatalog)
      const rows: Row[] = this.catalogs.map((catalog) => ({
        id: `catalog:${catalog.id}`,
        kind: "catalog",
        label: `${catalog.permanent ? "◆" : "◇"} ${catalog.name}  ·  ${catalog.hydration === "deferred" || catalog.hydration === "partial" ? "Browse to load" : `${catalog.kits.length} kits`}${catalog.kind === "remote" ? "  ·  remote catalog" : catalog.kind === "repo" ? "  ·  automatic" : catalog.permanent ? "  ·  built-in" : "  ·  registered"}${catalog.cache ? `  ·  ${catalogCacheLabel(catalog.cache)}` : ""}`,
        catalog,
      }))
      if (this.issueCount())
        rows.push({
          id: "health",
          kind: "health",
          label: `! Source and output status · ${this.issueCount()} issues`,
        })
      rows.push({
        id: "register",
        kind: "register",
        label: "+ Register an external catalog",
      })
      if (this.registering) {
        rows.push({
          id: "source",
          kind: "source",
          label: "Catalog path or URL",
          indent: true,
        })
      }
      return rows
    }
    if (this.page === 1) {
      const items = new Map(
        this.installedKits().map((item) => [item.key, item]),
      )
      for (const draft of this.drafts.values())
        items.set(draft.item.key, draft.item)
      const issues: Row[] = this.issueCount()
        ? [
            {
              id: "health",
              kind: "health",
              label: `! Source and output status · ${this.issueCount()} issues`,
            },
          ]
        : []
      issues.push(
        ...this.drift.files
          .filter((file) => file.status !== "current")
          .map((file, index): Row => ({
            id: `drift-file:${index}`,
            kind: "drift-file",
            label: `! Managed output ${index + 1} · ${file.status}`,
            fileDrift: file,
          })),
      )
      return [...issues, ...this.kitRows([...items.values()])]
    }
    if (this.page === 3) return this.settingsRows()
    const updates = this.updateRows()
    if (!this.plan || !this.stagedCount())
      return [
        ...updates,
        ...(!updates.length
          ? ([
              {
                id: "empty-review",
                kind: "heading",
                label: "Stage kits or settings, then return here.",
              },
            ] as Row[])
          : []),
      ]
    const rows: Row[] = [
      {
        id: "review-actions",
        kind: "actions",
        label: `${this.plan.changes.length} file changes · ${this.stagedCount()} staged changes`,
        choices: [
          {
            value: "apply",
            label: "Apply changes",
            selected: false,
            description:
              "Apply changes writes all listed files and saves settings and installation intent. Space is the final confirmation.",
          },
          {
            value: "edit",
            label: "Keep editing",
            selected: false,
            description:
              "Return to staged changes without writing. Reviewing does not write any files.",
          },
        ],
        focusedOptionIndex: this.optionFocus.get("review-actions") ?? 1,
      },
    ]
    rows.push(
      ...updates,
      ...this.plan.changes.map((change, changeIndex): Row => ({
        id: `change:${changeIndex}`,
        kind: "change",
        label: `${change.before === null ? "+" : change.after === null ? "−" : "~"} ${this.displayPath(change.path)}`,
        changeIndex,
      })),
    )
    return rows
  }
  displayPath(path: string): string {
    if (path.startsWith(`${this.backend.repository}/`))
      return `./${path.slice(this.backend.repository.length + 1)}`
    if (path.startsWith(`${this.backend.home}/`))
      return `~/${path.slice(this.backend.home.length + 1)}`
    return path
  }
  settingsChanged(): boolean {
    return (
      !!this.settingsDraft &&
      canonical(this.settingsDraft) !== canonical(this.savedSettings)
    )
  }
  stagedCount(): number {
    return this.drafts.size + Number(this.settingsChanged())
  }
  private settingsRows(): Row[] {
    const settings = this.settingsDraft ?? this.savedSettings
    if (!settings) return []
    const rows: Row[] = []
    for (const group of destinationGroups) {
      const value = settings[group.key]
      rows.push({
        id: `settings:${group.key}`,
        kind: "settings-group",
        settingsGroup: group.key,
        label: group.label,
        scope: group.scope,
        staged: canonical(value) !== canonical(this.savedSettings?.[group.key]),
        description: `${value.locations.length} locations · ${value.mode === "copy" ? "Copy" : "Link"}`,
      })
      const form = this.settingsForm
      if (form?.group !== group.key) continue
      const modeId = `settings:${group.key}:mode`
      rows.push({
        id: modeId,
        kind: "choice",
        label: "Additional locations",
        settingsGroup: group.key,
        indent: true,
        choices: ["copy", "link"].map((mode) => ({
          value: mode,
          label: mode === "copy" ? "Copy" : "Link",
          selected: form.mode === mode,
        })),
        focusedOptionIndex:
          this.optionFocus.get(modeId) ?? (form.mode === "copy" ? 0 : 1),
      })
      form.locations.forEach((location, index) => {
        const id = `settings:${group.key}:location:${location.id}`
        rows.push({
          id,
          kind: "location",
          primary: index === 0,
          settingsGroup: group.key,
          locationId: location.id,
          indent: true,
          label: `${index + 1}${index === 0 ? "  Primary" : ""}`,
          value: location.value,
          choices: [
            { value: "edit", label: "Edit", selected: false },
            {
              value: "up",
              label: "Move up",
              selected: false,
              disabled: index === 0,
            },
            {
              value: "down",
              label: "Move down",
              selected: false,
              disabled: index === form.locations.length - 1,
            },
            { value: "remove", label: "Remove", selected: false },
          ],
          focusedOptionIndex: this.optionFocus.get(id) ?? 0,
        })
        if (form.inputId === location.id)
          rows.push({
            id: `${id}:input`,
            kind: "location-input",
            label: "Location",
            settingsGroup: group.key,
            locationId: location.id,
            value: location.value,
            indent: true,
          })
      })
      rows.push({
        id: `settings:${group.key}:add`,
        kind: "actions",
        label: "",
        settingsGroup: group.key,
        indent: true,
        choices: [{ value: "add", label: "+ Add location", selected: false }],
        focusedOptionIndex: 0,
      })
      const id = `settings:${group.key}:actions`
      rows.push({
        id,
        kind: "actions",
        label: "",
        settingsGroup: group.key,
        indent: true,
        choices: [
          { value: "accept", label: "Accept", selected: false },
          { value: "cancel", label: "Cancel", selected: false },
        ],
        focusedOptionIndex: this.optionFocus.get(id) ?? 0,
      })
    }
    rows.push({
      id: "settings:ignore",
      kind: "settings-group",
      settingsGroup: "ignore",
      label: "Generated file ignores",
      scope: "repository",
      description:
        settings.ignore === "none"
          ? "None"
          : settings.ignore === "shared"
            ? "Shared"
            : "Local",
      staged: settings.ignore !== this.savedSettings?.ignore,
    })
    if (this.settingsForm?.group === "ignore") {
      const id = "settings:ignore:mode"
      const modes = ["none", "shared", "local"] as const
      rows.push({
        id,
        kind: "choice",
        label: "Ignore rules",
        settingsGroup: "ignore",
        indent: true,
        choices: modes.map((value) => ({
          value,
          label:
            value === "none" ? "None" : value === "shared" ? "Shared" : "Local",
          selected: this.settingsForm!.ignore === value,
        })),
        focusedOptionIndex:
          this.optionFocus.get(id) ?? modes.indexOf(this.settingsForm.ignore),
      })
      rows.push({
        id: "settings:ignore:actions",
        kind: "actions",
        label: "",
        settingsGroup: "ignore",
        indent: true,
        choices: [
          { value: "accept", label: "Accept", selected: false },
          { value: "cancel", label: "Cancel", selected: false },
        ],
        focusedOptionIndex:
          this.optionFocus.get("settings:ignore:actions") ?? 0,
      })
    }
    const restoring = this.settingsForm?.group === "restore"
    rows.push({
      id: "settings:restore",
      kind: "settings-group",
      label: "Restore defaults",
      description: restoring
        ? "Restore destination and ignore preferences."
        : undefined,
    })
    if (restoring)
      rows.push({
        id: "settings:restore:actions",
        kind: "actions",
        label: "",
        indent: true,
        choices: [
          { value: "accept", label: "Accept", selected: false },
          { value: "cancel", label: "Cancel", selected: false },
        ],
        focusedOptionIndex:
          this.optionFocus.get("settings:restore:actions") ?? 0,
      })
    return rows
  }
  private openSettings(group: UISettingsKey | "restore"): void {
    const value =
      group === "restore" || group === "ignore"
        ? undefined
        : (this.settingsDraft ?? this.savedSettings)?.[group]
    this.settingsForm = {
      group,
      locations:
        value?.locations.map((value) => ({
          id: String(++this.nextLocationId),
          value,
        })) ?? [],
      mode: value?.mode ?? "copy",
      ignore: (this.settingsDraft ?? this.savedSettings)!.ignore,
    }
    this.optionFocus.clear()
    this.cursor = Math.max(
      0,
      this.rows().findIndex(
        (row) =>
          row.id ===
          `settings:${group}:${group === "restore" ? "actions" : "mode"}`,
      ),
    )
    this.message =
      "Choose preferences, then Accept to stage. Review and Apply saves settings."
  }
  private acceptSettings(): void {
    const form = this.settingsForm
    if (!form) return
    try {
      const candidate = structuredClone(
        this.settingsDraft ?? this.savedSettings!,
      )
      if (form.group === "restore") {
        // Restore only the preferences exposed by this editor.
        for (const { key } of destinationGroups)
          candidate[key] = structuredClone(this.defaultsSettings![key])
        candidate.ignore = this.defaultsSettings!.ignore
      } else if (form.group === "ignore") candidate.ignore = form.ignore
      else
        candidate[form.group] = {
          locations: form.locations.map((location) => location.value.trim()),
          mode: form.mode,
        }
      const parsed = outputSettingsSchema.safeParse(candidate)
      if (!parsed.success)
        throw new Error(
          parsed.error.issues[0]?.message ?? "Check the location settings.",
        )
      if (form.group !== "restore" && form.group !== "ignore") {
        const locations = candidate[form.group].locations
        if (new Set(locations).size !== locations.length)
          throw new Error("Each location must be unique within this group.")
        for (const location of locations) {
          if (location.includes("\\") || location.split("/").includes(".."))
            throw new Error(
              "Use forward slashes without parent traversal in locations.",
            )
          if (
            form.group.startsWith("repository") &&
            (location.startsWith("/") || location.startsWith("~"))
          )
            throw new Error(
              "Repository locations must be relative to the project.",
            )
          if (location.startsWith("~") && !location.startsWith("~/"))
            throw new Error("Use ~/ for home locations.")
        }
      }
      this.stagedSettingsGroups.clear()
      for (const group of settingsKeys)
        if (
          canonical(candidate[group]) !== canonical(this.savedSettings![group])
        )
          this.stagedSettingsGroups.add(group)
      this.settingsDraft = this.stagedSettingsGroups.size
        ? candidate
        : undefined
      this.closeSettings()
      this.plan = undefined
      this.message =
        "Settings staged. Review before applying. Nothing written yet."
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error)
    }
    this.changed()
  }
  private closeSettings(): void {
    const group = this.settingsForm?.group
    this.settingsForm = undefined
    this.editing = undefined
    this.cursor = Math.max(
      0,
      this.rows().findIndex((row) => row.id === `settings:${group}`),
    )
  }
  private activateSettings(row: Row): void {
    if (row.kind === "settings-group") {
      this.openSettings(row.settingsGroup ?? "restore")
      return
    }
    const form = this.settingsForm
    if (!form) return
    const action = row.choices?.[row.focusedOptionIndex ?? 0]?.value
    if (row.id.endsWith(":actions")) {
      if (action === "cancel") {
        this.closeSettings()
        this.message =
          "Settings edit discarded. Previously staged changes are unchanged."
      } else this.acceptSettings()
    } else if (row.id.endsWith(":mode")) {
      if (form.group === "ignore")
        form.ignore = action as OutputSettings["ignore"]
      else form.mode = action as "copy" | "link"
    } else if (action === "add") {
      const location = { id: String(++this.nextLocationId), value: "" }
      form.locations.push(location)
      this.editLocation(location.id)
    } else if (row.kind === "location") {
      const index = form.locations.findIndex(
        (location) => location.id === row.locationId,
      )
      if (action === "edit") this.editLocation(row.locationId!)
      else if (action === "remove") {
        form.locations.splice(index, 1)
        if (form.inputId === row.locationId) form.inputId = undefined
        const nextId =
          form.locations[Math.min(index, form.locations.length - 1)]?.id
        this.cursor = Math.max(
          0,
          this.rows().findIndex(
            (candidate) =>
              (nextId !== undefined && candidate.locationId === nextId) ||
              candidate.id === `settings:${form.group}:add`,
          ),
        )
      } else {
        const next = index + (action === "up" ? -1 : 1)
        if (next >= 0 && next < form.locations.length) {
          const [location] = form.locations.splice(index, 1)
          form.locations.splice(next, 0, location!)
          this.cursor = this.rows().findIndex(
            (candidate) => candidate.id === row.id,
          )
        } else
          this.message =
            action === "up"
              ? "This location is already first."
              : "This location is already last."
      }
    } else if (row.kind === "location-input")
      this.editing = { kind: "location", id: row.locationId! }
  }
  private editLocation(id: string): void {
    this.settingsForm!.inputId = id
    this.editing = { kind: "location", id }
    this.cursor = this.rows().findIndex(
      (row) => row.kind === "location-input" && row.locationId === id,
    )
    this.message =
      "Type a location · Enter finishes input · Esc accepts this group"
  }
  selected(): Row | undefined {
    return this.rows()[this.cursor]
  }
  move(delta: number): void {
    if (this.busy) return
    this.editing = undefined
    const rows = this.rows()
    const hasKits = rows.some((row) => row.kind === "kit")
    // An open kit becomes its own navigation loop, not part of the outer list.
    const focusable = rows.flatMap((row, index) =>
      row.kind !== "heading" &&
      (row.kind !== "search" || !hasKits) &&
      (!this.form ||
        (row.item?.key === this.form.item.key && row.kind !== "kit")) &&
      (!this.registering || row.kind === "source") &&
      (!this.settingsForm ||
        (this.settingsForm.group === "restore"
          ? row.id === "settings:restore:actions"
          : row.settingsGroup === this.settingsForm.group &&
            row.kind !== "settings-group"))
        ? [index]
        : [],
    )
    if (!focusable.length) return
    const current = focusable.indexOf(this.cursor)
    const next =
      current < 0
        ? delta < 0
          ? focusable.length - 1
          : 0
        : (((current + delta) % focusable.length) + focusable.length) %
          focusable.length
    this.cursor = focusable[next]!
    const focused = rows[this.cursor]
    if (focused?.kind === "input" && focused.question)
      this.editing = { kind: "question", id: focused.question.id }
    else if (focused?.kind === "source") this.editing = { kind: "catalog" }
    else if (focused?.kind === "search") this.editing = { kind: "search" }
    else if (focused?.kind === "location-input")
      this.editing = { kind: "location", id: focused.locationId! }
    this.changed()
  }
  moveOption(delta: number): void {
    if (this.busy || this.editing) return
    const row = this.selected()
    if (!row?.choices?.length) return
    this.optionFocus.set(
      row.id,
      Math.max(
        0,
        Math.min(row.choices.length - 1, (row.focusedOptionIndex ?? 0) + delta),
      ),
    )
    this.changed()
  }
  async cycle(backward = false): Promise<void> {
    if (this.busy) return
    if (this.form || this.settingsForm || this.registering) {
      this.message = "Accept or cancel the inline form before changing tabs."
      this.changed()
      return
    }
    if (this.page === 2)
      this.message = "Staged changes are kept. Review before applying."
    this.editing = undefined
    this.page = (this.page + (backward ? pages.length - 1 : 1)) % pages.length
    this.cursor = 0
    if (this.page === 2) await this.review()
    else
      await this.run(async () => {
        await this.loadStatus()
      })
  }
  async review(focusId?: string): Promise<void> {
    this.optionFocus.delete("review-actions")
    await this.run(async () => {
      await this.loadStatus(true)
      this.plan = undefined
      if (!this.stagedCount() && !this.updateOffers().length) {
        this.message =
          "No staged changes. Choose a kit or configure settings to get started."
        return
      }
      this.plan = await this.backendOperation(() =>
        this.backend.plan([...this.drafts.values()], this.settingsDraft),
      )
      if (focusId)
        this.cursor = Math.max(
          0,
          this.rows().findIndex((row) => row.id === focusId),
        )
      this.message = this.stagedCount()
        ? "Reviewing does not write. Choose Apply changes, then Space writes all listed files and saves settings and intent."
        : "Kit updates are available. Keep installed is the default; configure an update to review its changes."
    })
  }
  back(): void {
    if (this.busy) return
    if (this.settingsForm) {
      this.acceptSettings()
      return
    }
    if (this.form) {
      this.acceptForm()
      return
    }
    if (this.editing) {
      if (this.editing.kind === "search")
        this.message = "Search filter kept. ↑↓ kits · / edit search · Esc back"
      this.editing = undefined
    } else if (this.registering) {
      this.registering = false
      this.cursor = this.catalogs.length
    } else if (this.page === 0 && this.catalog) {
      this.cancelCatalogRefresh()
      const id = this.catalog.id
      this.catalog = undefined
      this.cursor = Math.max(
        0,
        this.catalogs.findIndex((c) => c.id === id),
      )
    }
    this.changed()
  }
  acceptForm(): void {
    if (this.busy || !this.form) return
    try {
      const { item, scope } = this.form
      const reviewUpdate = this.form.reviewUpdate
      const answers =
        scope === "none" ? {} : validateAnswers(item.kit, this.form.answers)
      this.editing = undefined
      this.drafts.set(item.key, {
        item,
        scope,
        answers,
        definition: this.form.fromCatalog ? "catalog" : "saved",
        ...(!this.form.scopeChanged && scope === this.form.originalScope
          ? { update: true }
          : {}),
      })
      if (this.form.scopeChanged) this.scopeChangedDrafts.add(item.key)
      else this.scopeChangedDrafts.delete(item.key)
      this.form = undefined
      this.plan = undefined
      this.cursor = Math.max(
        0,
        this.rows().findIndex(
          (row) =>
            row.id ===
            (reviewUpdate ? `update-offer:${item.key}` : `kit:${item.key}`),
        ),
      )
      this.message = `Staged ${item.kit.name}. Tab to Review when ready. No files written yet.`
      if (reviewUpdate) void this.review(`update-offer:${item.key}`)
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error)
    }
    this.changed()
  }
  cancelForm(): void {
    if (this.busy || !this.form) return
    const key = this.form.item.key
    const reviewUpdate = this.form.reviewUpdate
    this.form = undefined
    this.editing = undefined
    this.cursor = Math.max(
      0,
      this.rows().findIndex(
        (row) =>
          row.id === (reviewUpdate ? `update-offer:${key}` : `kit:${key}`),
      ),
    )
    this.message =
      "Kit edit discarded. Previously staged selections are unchanged."
    if (reviewUpdate) void this.review(`update-offer:${key}`)
    this.changed()
  }
  edit(value: string): void {
    if (this.editing?.kind === "search" && this.catalog && this.page === 0)
      this.catalogFilters.set(
        canonical([this.catalog.source, this.catalog.id]),
        value,
      )
    else if (this.editing?.kind === "catalog") this.source = value
    else if (this.editing?.kind === "question" && this.form)
      this.form.answers[this.editing.id] = value
    else if (this.editing?.kind === "location" && this.settingsForm) {
      const id = this.editing.id
      const location = this.settingsForm.locations.find(
        (entry) => entry.id === id,
      )
      if (location) location.value = value
      this.message =
        "Type a location · Enter finishes input · Esc accepts this group"
    }
    this.changed()
  }
  async finishInput(): Promise<void> {
    if (this.editing?.kind === "catalog") {
      await this.run(async () => {
        const catalog = await this.backendOperation(() =>
          this.backend.register(this.source.trim()),
        )
        this.registering = false
        this.editing = undefined
        this.source = ""
        await this.initialize()
        this.cursor = Math.max(
          0,
          this.catalogs.findIndex(
            (item) => item.id === catalog.id && item.source === catalog.source,
          ),
        )
        this.message =
          "External catalog registered. No kit files were installed."
      })
    } else {
      if (this.editing?.kind === "search")
        this.message = "Search filter kept. ↑↓ kits · / edit search · Esc back"
      this.editing = undefined
      this.changed()
    }
  }
  async activate(): Promise<void> {
    if (this.busy || this.editing) return
    const row = this.selected()
    if (!row) return
    if (this.page === 3) {
      this.activateSettings(row)
      this.changed()
      return
    }
    if (row.kind === "catalog") {
      if (
        row.catalog?.kind === "remote" &&
        row.catalog.hydration === "loaded"
      ) {
        this.enterCatalog(row.catalog)
        void this.revalidateCatalog(row.catalog)
      } else {
        this.message = "Loading catalog…"
        await this.run(async () => {
          this.enterCatalog(await this.fetchCatalog(row.catalog!.source))
        })
      }
    } else if (row.kind === "search") {
      this.focusSearch()
    } else if (row.kind === "update-offer" && row.sourceDrift) {
      this.optionFocus.delete("review-actions")
      if (row.choices![row.focusedOptionIndex ?? 0]!.value === "keep") {
        if (
          this.drafts.get(row.sourceDrift.key)?.scope === "none" ||
          this.updateStaged(row.sourceDrift.key)
        ) {
          this.drafts.delete(row.sourceDrift.key)
          this.scopeChangedDrafts.delete(row.sourceDrift.key)
          await this.review(row.id)
        }
        this.message =
          "Saved content kept. Other staged configuration changes are unchanged."
      } else
        await this.run(async () => {
          const key = row.sourceDrift!.key
          await this.loadStatus()
          const issue = this.sourceDrift(key)
          if (issue?.status !== "changed" || !issue.latest)
            throw new Error(
              "The update is no longer available. The saved installation and staged changes are kept.",
            )
          const config = this.configuration(issue.latest)
          const reconciled = answersForUpdate(
            issue.latest.kit,
            config.answers ?? {},
          )
          this.form = {
            item: issue.latest,
            scope: config.scope,
            answers: reconciled.answers,
            fromCatalog: true,
            reviewUpdate: true,
            originalScope: config.scope,
            scopeChanged:
              this.drafts.has(key) && this.scopeChangedDrafts.has(key),
          }
          this.optionFocus.clear()
          this.cursor = this.rows().findIndex(
            (candidate) => candidate.id === "scope",
          )
          this.message =
            "Review the update and answers. Esc or Accept stages; Cancel keeps previous drafts."
        })
    } else if (row.kind === "kit" && row.item) {
      if (this.form) {
        this.message = "Accept or cancel the current kit first."
        this.changed()
        return
      }
      this.cancelCatalogRefresh()
      const config = this.configuration(row.item)
      const draft = this.drafts.get(row.item.key)
      const installed = this.installedItems().get(row.item.key)
      const scopeChanged = !!draft && this.scopeChangedDrafts.has(row.item.key)
      const updating =
        !scopeChanged &&
        (draft?.update ||
          (row.fromCatalog &&
            installed &&
            !sameSourceContent(row.item, installed)))
      this.form = {
        item: row.item,
        scope: config.scope === "none" ? "repository" : config.scope,
        answers: answersForUpdate(row.item.kit, config.answers ?? {}).answers,
        fromCatalog: row.fromCatalog || draft?.definition === "catalog",
        scopeChanged,
        ...(updating ? { originalScope: config.scope } : {}),
      }
      this.optionFocus.clear()
      this.cursor = this.rows().findIndex((row) => row.id === "scope")
      this.message =
        "↑↓/jk questions · ←→/hl options · Space selects/toggles · Esc accepts · Cancel discards"
    } else if (row.kind === "scope" && this.form) {
      this.optionFocus.set(row.id, row.focusedOptionIndex ?? 0)
      const scope = row.choices![row.focusedOptionIndex ?? 0]!.value as Scope
      if (scope !== this.form.scope) {
        this.form.scopeChanged = true
        this.form.originalScope = undefined
      }
      this.form.scope = scope
    } else if (row.kind === "choice" && row.question && this.form) {
      this.optionFocus.set(row.id, row.focusedOptionIndex ?? 0)
      const id = row.question.id
      const value = row.choices![row.focusedOptionIndex ?? 0]!.value
      if (row.question.type === "multi-select") {
        const values = (this.form.answers[id] ?? []) as string[]
        this.form.answers[id] = values.includes(String(value))
          ? values.filter((v) => v !== value)
          : [...values, String(value)]
      } else this.form.answers[id] = value
    } else if (row.kind === "input")
      this.editing = { kind: "question", id: row.question!.id }
    else if (row.kind === "source") this.editing = { kind: "catalog" }
    else if (row.kind === "update" && this.form) {
      const key = this.form.item.key
      await this.run(async () => {
        await this.loadStatus()
        const removed = !this.installedItems().has(key)
        const latest = this.updateSource(this.form!.item)
        if (!latest)
          throw new Error(
            removed
              ? "This kit was uninstalled in another session, and its original source cannot be resolved here. Your current answers are kept; accept the saved kit or choose Cancel."
              : "The source is unavailable. The saved kit is still usable; no update was staged.",
          )
        const reconciled = answersForUpdate(latest.kit, this.form!.answers)
        this.form!.item = latest
        this.form!.answers = reconciled.answers
        this.form!.fromCatalog = true
        if (!this.form!.scopeChanged)
          this.form!.originalScope = this.form!.scope
        this.optionFocus.clear()
        this.cursor = this.rows().findIndex((item) => item.id === "scope")
        this.message =
          (removed
            ? "This kit was uninstalled in another session. Nothing is reinstalled until Accept, Review, and Apply changes. "
            : "") +
          (reconciled.reset.length || reconciled.removed
            ? "Catalog update loaded. Review new or reset answers, then accept and review changes."
            : "Catalog update loaded with compatible saved answers. Accept, then Review to apply.")
      })
    } else if (row.kind === "actions" && this.form) {
      if (row.choices![row.focusedOptionIndex ?? 0]!.value === "cancel") {
        this.cancelForm()
      } else this.acceptForm()
      return
    } else if (row.kind === "register") {
      this.registering = true
      this.editing = { kind: "catalog" }
      this.cursor += 1
      this.message = "Enter an external catalog path or HTTPS URL."
    } else if (row.kind === "health") {
      this.page = 1
      this.cursor = 0
    } else if (row.kind === "drift-file") {
      this.page = 2
      this.cursor = 0
      await this.review()
      this.message =
        "Review shows managed output paths and status. Drift must be reconciled before applying."
    } else if (row.id === "review-actions" && this.plan) {
      if (row.choices![row.focusedOptionIndex ?? 1]!.value === "edit") {
        this.page = !this.drafts.size && this.settingsChanged() ? 3 : 1
        this.plan = undefined
        this.cursor = Math.max(
          0,
          this.rows().findIndex(
            (row) =>
              row.kind === "kit" && row.item && this.drafts.has(row.item.key),
          ),
        )
        this.message =
          "Keep editing your staged changes. No files written. Tab to Review for a fresh plan."
      } else {
        const plan = this.plan
        await this.run(async () => {
          await this.backendOperation(() => this.backend.apply(plan))
          this.drafts.clear()
          this.scopeChangedDrafts.clear()
          this.settingsDraft = undefined
          this.stagedSettingsGroups.clear()
          this.plan = undefined
          this.cursor = 0
          await this.loadStatus()
          this.message =
            "Applied successfully. Your installation intent is saved."
        })
      }
    }
    this.cursor = Math.max(0, Math.min(this.cursor, this.rows().length - 1))
    this.changed()
  }
  private async run(action: () => Promise<void>): Promise<void> {
    this.cancelCatalogRefresh()
    this.busy = true
    this.changed()
    try {
      await action()
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error)
      this.plan = undefined
      this.cursor = this.form
        ? Math.max(
            0,
            this.rows().findIndex((row) => row.id === "scope"),
          )
        : this.registering
          ? Math.max(
              0,
              this.rows().findIndex((row) => row.kind === "source"),
            )
          : 0
    } finally {
      this.busy = false
      this.changed()
    }
  }
}
