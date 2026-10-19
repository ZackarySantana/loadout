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
  indent?: boolean
  item?: LoadedKit
  scope?: Scope
  staged?: boolean
  catalog?: Catalog
  question?: Question
  choices?: RowChoice[]
  focusedOptionIndex?: number
  changeIndex?: number
}
interface Form {
  item: LoadedKit
  scope: Scope
  answers: Answers
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
>

export class ScreenModel {
  page = 0
  cursor = 0
  catalog?: Catalog
  catalogs: Catalog[] = []
  errors: string[] = []
  drafts = new Map<string, Selection>()
  form?: Form
  plan?: Plan
  busy = false
  message =
    "Space opens a catalog. Nothing is written until you review and apply."
  editing?: { kind: "catalog" } | { kind: "question"; id: string }
  registering = false
  source = ""
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
    await this.backend.refresh()
    const { catalogs, errors } = await this.backend.catalogs()
    this.catalogs = catalogs
    this.errors = errors
    if (errors.length) this.message = `Catalog warning: ${errors.join("; ")}`
    this.changed()
  }

  configuration(item: LoadedKit): { scope: Scope; answers?: Answers } {
    const draft = this.drafts.get(item.key)
    return draft
      ? { scope: draft.scope, answers: draft.answers }
      : this.backend.configuration(item.key)
  }
  private kitRows(items: LoadedKit[]): Row[] {
    const rows: Row[] = []
    for (const item of items) {
      const config = this.configuration(item)
      rows.push({
        id: `kit:${item.key}`,
        kind: "kit",
        label: `${config.scope === "none" ? "○" : "●"} ${item.kit.name}  ${config.scope === "none" ? "" : `[${config.scope}]`}${this.drafts.has(item.key) ? " *" : ""}`,
        item,
        scope: config.scope,
        staged: this.drafts.has(item.key),
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
      if (this.catalog) return this.kitRows(this.catalog.kits)
      const rows: Row[] = this.catalogs.map((catalog) => ({
        id: `catalog:${catalog.id}`,
        kind: "catalog",
        label: `${catalog.permanent ? "◆" : "◇"} ${catalog.name}  ·  ${catalog.kits.length} kits${catalog.permanent ? "  ·  built-in" : ""}`,
        catalog,
      }))
      rows.push({
        id: "register",
        kind: "register",
        label: "+ Register a catalog",
      })
      if (this.registering)
        rows.push({
          id: "source",
          kind: "source",
          label: "Catalog JSON path or HTTPS URL",
          indent: true,
        })
      return rows
    }
    if (this.page === 1) {
      const items = new Map(
        this.backend.installed().map((item) => [item.key, item]),
      )
      for (const draft of this.drafts.values())
        items.set(draft.item.key, draft.item)
      return this.kitRows([...items.values()])
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
    if (this.busy || this.editing?.kind === "catalog") return
    this.editing = undefined
    const rows = this.rows()
    // An open kit becomes its own navigation loop, not part of the outer list.
    const focusable = rows.flatMap((row, index) =>
      row.kind !== "heading" &&
      (!this.form ||
        (row.item?.key === this.form.item.key && row.kind !== "kit"))
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
    this.page = (this.page + (backward ? 2 : 1)) % pages.length
    this.cursor = 0
    if (this.page === 2) await this.review()
    else
      await this.run(async () => {
        await this.backend.refresh()
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
        await this.backend.register(this.source.trim())
        this.registering = false
        this.editing = undefined
        this.source = ""
        await this.initialize()
        this.cursor = this.catalogs.length - 1
        this.message = "Catalog registered. Space to browse its kits."
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
        answers: { ...defaults(row.item.kit), ...config.answers },
      }
      this.optionFocus.clear()
      this.cursor = this.rows().findIndex((row) => row.id === "scope")
      this.message =
        "↑↓/jk questions · ←→/hl options · Space selects/toggles · Esc accepts · Cancel discards"
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
    else if (row.kind === "actions" && this.form) {
      if (row.choices![row.focusedOptionIndex ?? 0]!.value === "cancel") {
        this.cancelForm()
      } else this.acceptForm()
      return
    } else if (row.kind === "register") {
      this.registering = true
      this.editing = { kind: "catalog" }
      this.cursor += 1
      this.message =
        "Enter a local catalog.json path or HTTPS URL, then press Enter."
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
      this.cursor = 0
    } finally {
      this.busy = false
      this.changed()
    }
  }
}
