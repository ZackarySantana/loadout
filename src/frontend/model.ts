import {
  activeAnswers,
  defaults,
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
import { answersForUpdate } from "./answers"

export const pages = ["Catalogs", "Installed", "Review"] as const
export interface RowChoice {
  value: string | boolean
  label: string
  selected: boolean
  description?: string
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
    | "actions"
    | "register"
    | "source"
    | "change"
    | "health"
    | "drift-file"
    | "update"
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
}
interface Form {
  item: LoadedKit
  scope: Scope
  answers: Answers
  fromCatalog?: boolean
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
>

export class ScreenModel {
  page = 0
  cursor = 0
  catalog?: Catalog
  catalogs: Catalog[] = []
  errors: string[] = []
  drift: DriftReport = { kits: [], files: [] }
  drafts = new Map<string, Selection>()
  form?: Form
  plan?: Plan
  busy = false
  message =
    "Space opens a catalog. Nothing is written until you review and apply."
  editing?: { kind: "catalog" } | { kind: "question"; id: string }
  registering = false
  source = ""
  registrationScope: "repository" | "global" = "repository"
  private optionFocus = new Map<string, number>()
  private listeners = new Set<() => void>()

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
  async initialize(): Promise<void> {
    await this.loadStatus()
    this.message = this.issueCount()
      ? "Catalog or output drift found. Installed shows details; saved kits are kept."
      : "Choose a catalog. Repository catalogs are discovered from this project."
    this.changed()
  }
  private async loadStatus(): Promise<void> {
    const { catalogs, errors, drift } = await this.backend.status()
    this.catalogs = catalogs
    this.errors = errors
    this.drift = drift
    if (this.catalog)
      this.catalog = catalogs.find(
        (catalog) =>
          catalog.id === this.catalog!.id &&
          catalog.source === this.catalog!.source,
      )
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
    const saved = this.backend.installed().find((item) => item.key === key)
    return (
      !!draft &&
      draft.scope !== "none" &&
      !!saved &&
      (canonical(draft.item.kit) !== canonical(saved.kit) ||
        canonical(draft.item.origin) !== canonical(saved.origin))
    )
  }
  canUpdate(item: LoadedKit): boolean {
    const latest = this.updateSource(item)
    return (
      !!latest &&
      canonical(item.kit) !== canonical(latest.kit) &&
      (!item.origin || item.origin.source === latest.origin?.source)
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
    return latest ? { ...latest, origin } : undefined
  }
  async refreshStatus(): Promise<void> {
    if (this.busy) return
    if (this.form || this.registering) {
      this.message = "Accept or cancel the open form before refreshing sources."
      this.changed()
      return
    }
    const selected = this.selected()?.id
    await this.run(async () => {
      await this.loadStatus()
      this.plan = undefined
      if (this.page === 2 && this.drafts.size) {
        this.optionFocus.delete("review-actions")
        this.plan = await this.backend.plan([...this.drafts.values()])
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
    const inventory = new Map(items.map((item) => [item.key, item]))
    // Keep the working copy visible even if status removes/replaces its source
    // or installation. Only Accept or explicit Cancel ends the form's lifetime.
    if (this.form) inventory.set(this.form.item.key, this.form.item)
    for (const item of inventory.values()) {
      const config = this.configuration(item)
      rows.push({
        id: `kit:${item.key}`,
        kind: "kit",
        label: `${config.scope === "none" ? "○" : "●"} ${item.kit.name}  ${config.scope === "none" ? "" : `[${config.scope}]`}${this.drafts.has(item.key) ? " *" : ""}`,
        item,
        scope: config.scope,
        staged: this.drafts.has(item.key),
        fromCatalog:
          this.form?.item.key === item.key
            ? this.form.fromCatalog
            : fromCatalog,
        sourceDrift: this.sourceDrift(item.key),
        updateStaged: this.updateStaged(item.key),
      })
      if (this.form?.item.key === item.key)
        rows.push(...this.formRows(this.form))
    }
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
    if (this.page === 0) {
      if (this.catalog) {
        const rows: Row[] = [
          ...this.kitRows(this.catalog.kits, true),
          ...(this.catalog.unavailableKits ?? []).map((kit): Row => ({
            id: `unavailable:${kit.key}`,
            kind: "heading",
            label: `! ${kit.name}: ${kit.reason}`,
            catalog: this.catalog,
          })),
        ]
        if (!rows.length)
          rows.push({
            id: "empty-catalog",
            kind: "heading",
            label:
              "This catalog has no available kits. Saved installations remain in Installed.",
            catalog: this.catalog,
          })
        return rows
      }
      if (this.form) return this.kitRows([], this.form.fromCatalog)
      const rows: Row[] = this.catalogs.map((catalog) => ({
        id: `catalog:${catalog.id}`,
        kind: "catalog",
        label: `${catalog.permanent ? "◆" : "◇"} ${catalog.name}  ·  ${catalog.kits.length} kits${catalog.permanent ? "  ·  built-in" : `  ·  ${catalog.subscriptionScope === "both" ? "repository + global" : (catalog.subscriptionScope ?? "global")}`}`,
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
        label: "+ Register a catalog",
      })
      if (this.registering) {
        rows.push({
          id: "catalog-scope",
          kind: "scope",
          label: "Catalog available in",
          indent: true,
          choices: [
            {
              value: "repository",
              label: "Repository",
              selected: this.registrationScope === "repository",
              description:
                "Share a live source reference through this project's .loadout/catalogs.json. No kits are installed.",
            },
            {
              value: "global",
              label: "Global",
              selected: this.registrationScope === "global",
              description:
                "Make this source available in all your projects. No kits are installed.",
            },
          ],
          focusedOptionIndex: this.optionFocus.get("catalog-scope") ?? 0,
        })
        rows.push({
          id: "source",
          kind: "source",
          label: "Catalog JSON path or HTTPS URL",
          indent: true,
        })
      }
      return rows
    }
    if (this.page === 1) {
      const items = new Map(
        this.backend.installed().map((item) => [item.key, item]),
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
            label: `! ${file.status} · ${this.displayPath(file.path)}`,
            fileDrift: file,
          })),
      )
      return [...issues, ...this.kitRows([...items.values()])]
    }
    if (!this.plan)
      return [
        {
          id: "empty-review",
          kind: "heading",
          label: "Stage kits in Catalogs, then return here.",
        },
      ]
    const rows: Row[] = [
      {
        id: "review-actions",
        kind: "actions",
        label: `${this.plan.changes.length} file changes · ${this.drafts.size} staged selections`,
        choices: [
          {
            value: "apply",
            label: "Apply changes",
            selected: false,
            description:
              "Apply changes writes all listed files and saves installation intent. Space is the final confirmation.",
          },
          {
            value: "edit",
            label: "Keep editing",
            selected: false,
            description:
              "Return to staged kits without writing. Reviewing does not write any files.",
          },
        ],
        focusedOptionIndex: this.optionFocus.get("review-actions") ?? 1,
      },
    ]
    rows.push(
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
  selected(): Row | undefined {
    return this.rows()[this.cursor]
  }
  move(delta: number): void {
    if (this.busy) return
    this.editing = undefined
    const rows = this.rows()
    // An open kit becomes its own navigation loop, not part of the outer list.
    const focusable = rows.flatMap((row, index) =>
      row.kind !== "heading" &&
      (!this.form ||
        (row.item?.key === this.form.item.key && row.kind !== "kit")) &&
      (!this.registering || row.id === "catalog-scope" || row.kind === "source")
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
    if (this.form || this.registering) {
      this.editing = undefined
      this.message = "Accept or cancel the inline form before changing tabs."
      this.changed()
      return
    }
    this.page = (this.page + (backward ? pages.length - 1 : 1)) % pages.length
    this.cursor = 0
    if (this.page === 2) await this.review()
    else
      await this.run(async () => {
        await this.loadStatus()
      })
  }
  async review(): Promise<void> {
    this.optionFocus.delete("review-actions")
    if (!this.drafts.size) {
      this.plan = undefined
      this.message = "No staged changes. Choose a kit to get started."
      this.changed()
      return
    }
    await this.run(async () => {
      await this.loadStatus()
      this.plan = await this.backend.plan([...this.drafts.values()])
      this.message =
        "Reviewing does not write. Choose Apply changes, then Space writes all listed files and saves intent."
    })
  }
  back(): void {
    if (this.busy) return
    if (this.form) {
      this.acceptForm()
      return
    }
    if (this.editing) this.editing = undefined
    else if (this.registering) {
      this.registering = false
      this.cursor = this.catalogs.length
    } else if (this.page === 0 && this.catalog) {
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
      const answers =
        scope === "none" ? {} : validateAnswers(item.kit, this.form.answers)
      this.editing = undefined
      this.drafts.set(item.key, { item, scope, answers })
      this.form = undefined
      this.plan = undefined
      this.cursor = Math.max(
        0,
        this.rows().findIndex((row) => row.id === `kit:${item.key}`),
      )
      this.message = `Staged ${item.kit.name}. Tab to Review when ready. No files written yet.`
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error)
    }
    this.changed()
  }
  cancelForm(): void {
    if (this.busy || !this.form) return
    const key = this.form.item.key
    this.form = undefined
    this.editing = undefined
    this.cursor = Math.max(
      0,
      this.rows().findIndex((row) => row.id === `kit:${key}`),
    )
    this.message =
      "Kit edit discarded. Previously staged selections are unchanged."
    this.changed()
  }
  edit(value: string): void {
    if (this.editing?.kind === "catalog") this.source = value
    else if (this.editing?.kind === "question" && this.form)
      this.form.answers[this.editing.id] = value
    this.changed()
  }
  async finishInput(): Promise<void> {
    if (this.editing?.kind === "catalog") {
      await this.run(async () => {
        const catalog = await this.backend.register(
          this.source.trim(),
          this.registrationScope,
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
        this.message = `Catalog subscribed for ${this.registrationScope}. No kit files were installed.`
      })
    } else {
      this.editing = undefined
      this.changed()
    }
  }
  async activate(): Promise<void> {
    if (this.busy || this.editing) return
    const row = this.selected()
    if (!row) return
    if (row.kind === "catalog") {
      this.catalog = row.catalog
      this.cursor = 0
      this.message = "Space configures a kit. Esc returns to catalogs."
    } else if (row.kind === "kit" && row.item) {
      if (this.form) {
        this.message = "Accept or cancel the current kit first."
        this.changed()
        return
      }
      const config = this.configuration(row.item)
      this.form = {
        item: row.item,
        scope: config.scope === "none" ? "repository" : config.scope,
        answers: answersForUpdate(row.item.kit, config.answers ?? {}).answers,
        fromCatalog: row.fromCatalog,
      }
      this.optionFocus.clear()
      this.cursor = this.rows().findIndex((row) => row.id === "scope")
      this.message =
        "↑↓/jk questions · ←→/hl options · Space selects/toggles · Esc accepts · Cancel discards"
    } else if (row.id === "catalog-scope") {
      this.optionFocus.set(row.id, row.focusedOptionIndex ?? 0)
      this.registrationScope = row.choices![row.focusedOptionIndex ?? 0]!
        .value as "repository" | "global"
    } else if (row.kind === "scope" && this.form) {
      this.optionFocus.set(row.id, row.focusedOptionIndex ?? 0)
      this.form.scope = row.choices![row.focusedOptionIndex ?? 0]!
        .value as Scope
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
        const removed = !this.backend
          .installed()
          .some((item) => item.key === key)
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
      this.editing = undefined
      this.registrationScope = "repository"
      this.optionFocus.delete("catalog-scope")
      this.cursor += 1
      this.message =
        "Choose catalog availability, then enter its path or HTTPS URL. Enter subscribes; no kit is installed."
    } else if (row.kind === "health") {
      this.page = 1
      this.cursor = 0
    } else if (row.id === "review-actions" && this.plan) {
      if (row.choices![row.focusedOptionIndex ?? 1]!.value === "edit") {
        this.page = 1
        this.plan = undefined
        this.cursor = Math.max(
          0,
          this.rows().findIndex(
            (row) =>
              row.kind === "kit" && row.item && this.drafts.has(row.item.key),
          ),
        )
        this.message =
          "Keep editing your staged kits. No files written. Tab to Review for a fresh plan."
      } else {
        const plan = this.plan
        await this.run(async () => {
          await this.backend.apply(plan)
          this.drafts.clear()
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
