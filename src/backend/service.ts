import {
  chmod,
  lstat,
  mkdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import { dirname, join, relative, isAbsolute } from "node:path"
import { hostname } from "node:os"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  type Answers,
  type Catalog,
  type ConfiguredKit,
  type LoadedKit,
  type Scope,
  kitSchema,
  validateAnswers,
} from "../domain/kit"
import { loadCatalog, loadCatalogs, normalizeSource } from "./catalogs"
import { assertSafePath, readOptional, reconcile } from "./files"
import { renderState } from "./render"
import { emptyState, stateSchema, type State } from "./state"

export interface Selection {
  item: LoadedKit
  scope: Scope
  answers: Answers
}
export interface Change {
  path: string
  before: string | null
  after: string | null
}
export interface Plan {
  changes: readonly Change[]
  summary: string[]
}
interface PlanData {
  before: string | null
  state: State
  changes: Change[]
}
const journalSchema = z.object({
  before: z.string().nullable(),
  after: z.string(),
  changes: z.array(
    z.object({
      path: z.string(),
      before: z.string().nullable(),
      after: z.string().nullable(),
      beforeMode: z.number().int().min(0).max(0o7777).optional(),
    }),
  ),
})

async function fileMode(path: string): Promise<number | undefined> {
  try {
    return (await lstat(path)).mode & 0o7777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function atomicWrite(
  path: string,
  content: string | null,
  restoreMode?: number,
): Promise<void> {
  await assertSafePath(path)
  if (content === null) {
    try {
      await unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return
  }
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.loadout-${randomUUID()}`
  const mode = restoreMode ?? (await fileMode(path)) ?? 0o600
  try {
    await writeFile(temp, content, { flag: "wx", mode: 0o600 })
    await chmod(temp, mode)
    await rename(temp, path)
  } finally {
    await unlink(temp).catch(() => {})
  }
}

export class LoadoutService {
  readonly home: string
  readonly repository: string
  private readonly directory: string
  private readonly statePath: string
  private state: State = emptyState()
  private raw: string | null = null
  private plans = new WeakMap<Plan, PlanData>()

  private constructor(home: string, repository: string) {
    this.home = home
    this.repository = repository
    this.directory = join(home, ".loadout")
    this.statePath = join(this.directory, "state.json")
  }

  static async open(options: {
    home: string
    repository: string
  }): Promise<LoadoutService> {
    const service = new LoadoutService(
      await realpath(options.home),
      await realpath(options.repository),
    )
    if (service.home === service.repository)
      throw new Error(
        "Choose a project directory rather than your home directory with --repo <path>",
      )
    await assertSafePath(service.statePath)
    await service.refresh()
    return service
  }

  private async reload(): Promise<void> {
    const raw = await readOptional(this.statePath)
    const state =
      raw === null ? emptyState() : stateSchema.parse(JSON.parse(raw))
    this.raw = raw
    this.state = state
  }

  /** Recover interrupted work and refresh cached catalog and scope intent under the state lock. */
  async refresh(): Promise<void> {
    await this.locked(() => this.reload())
  }

  async catalogs(): Promise<{ catalogs: Catalog[]; errors: string[] }> {
    return loadCatalogs(this.state.catalogs)
  }

  installed(): LoadedKit[] {
    const kits = {
      ...this.state.repositories[this.repository],
      ...this.state.global,
    }
    return structuredClone(
      Object.values(kits).map(({ key, kit }) => ({ key, kit })),
    )
  }

  configuration(key: string): { scope: Scope; answers?: Answers } {
    const repo = this.state.repositories[this.repository]?.[key]
    const global = this.state.global[key]
    return {
      scope:
        repo && global
          ? "both"
          : repo
            ? "repository"
            : global
              ? "global"
              : "none",
      answers: structuredClone((global ?? repo)?.answers),
    }
  }

  async register(source: string): Promise<Catalog> {
    const normalized = await normalizeSource(source, this.repository)
    const catalog = await loadCatalog(normalized)
    await this.locked(async () => {
      await this.reload()
      const existing = await this.catalogs()
      if (existing.catalogs.some((c) => c.id === catalog.id))
        throw new Error(`Catalog already registered: ${catalog.id}`)
      this.state.catalogs.push(normalized)
      await atomicWrite(
        this.statePath,
        JSON.stringify(this.state, null, 2) + "\n",
      )
      await this.reload()
    })
    return catalog
  }

  async unregister(source: string): Promise<void> {
    await this.locked(async () => {
      await this.reload()
      if (!this.state.catalogs.includes(source))
        throw new Error(
          "Only registered catalogs can be unregistered; Loadout is permanent",
        )
      this.state.catalogs = this.state.catalogs.filter((s) => s !== source)
      await atomicWrite(
        this.statePath,
        JSON.stringify(this.state, null, 2) + "\n",
      )
      await this.reload()
    })
  }

  async plan(selections: Selection[]): Promise<Plan> {
    // Snapshot caller-owned objects before the first await; later UI edits cannot alter a review.
    selections = structuredClone(selections)
    for (const selection of selections) {
      selection.item.kit = kitSchema.parse(selection.item.kit)
      selection.scope = z
        .enum(["repository", "global", "both", "none"])
        .parse(selection.scope)
    }
    // A new review always uses the latest persisted intentions, not a stale UI snapshot.
    await this.refresh()
    const previous = this.state
    const beforeState = this.raw
    const next = structuredClone(previous)
    const repo = (next.repositories[this.repository] ??= {})
    const summary: string[] = []
    const seen = new Set<string>()
    for (const { item, scope, answers } of selections) {
      if (seen.has(item.key))
        throw new Error(`Duplicate selection: ${item.key}`)
      if (
        !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(item.key) ||
        !item.key.endsWith(`/${item.kit.id}`)
      )
        throw new Error(`Invalid kit identity: ${item.key}`)
      seen.add(item.key)
      const config: ConfiguredKit = {
        key: item.key,
        kit: item.kit,
        answers: scope === "none" ? {} : validateAnswers(item.kit, answers),
      }
      if (scope === "global" || scope === "both") next.global[item.key] = config
      else delete next.global[item.key]
      if (scope === "repository" || scope === "both") repo[item.key] = config
      else delete repo[item.key]
      summary.push(
        `${item.kit.name}: ${scope === "none" ? "remove from global and this repository" : scope}`,
      )
    }
    next.managed = renderState(next, this.home)
    const changes: Change[] = []
    for (const path of new Set([
      ...Object.keys(previous.managed),
      ...Object.keys(next.managed),
    ])) {
      this.assertOwnedPath(path, next)
      await assertSafePath(path)
      const before = await readOptional(path)
      const after = reconcile(
        path,
        before,
        previous.managed[path],
        next.managed[path],
      )
      if (before !== after) changes.push({ path, before, after })
    }
    const plan: Plan = { changes: structuredClone(changes), summary }
    this.plans.set(plan, { before: beforeState, state: next, changes })
    return plan
  }

  async apply(plan: Plan): Promise<void> {
    const data = this.plans.get(plan)
    if (!data) throw new Error("Review a fresh plan before applying")
    await this.locked(async () => {
      if ((await readOptional(this.statePath)) !== data.before)
        throw new Error(
          "Selections changed in another session. Review again before applying.",
        )
      for (const change of data.changes) {
        await assertSafePath(change.path)
        if ((await readOptional(change.path)) !== change.before)
          throw new Error(
            `File changed since review; review again: ${change.path}`,
          )
      }
      const after = JSON.stringify(data.state, null, 2) + "\n"
      const changes = await Promise.all(
        data.changes.map(async (change) => ({
          ...change,
          beforeMode: await fileMode(change.path),
        })),
      )
      const journal = { before: data.before, after, changes }
      await atomicWrite(
        join(this.directory, "journal.json"),
        JSON.stringify(journal),
      )
      try {
        for (const change of data.changes)
          await atomicWrite(change.path, change.after)
        await atomicWrite(this.statePath, after)
      } catch (error) {
        await this.recover()
        throw error
      }
      await unlink(join(this.directory, "journal.json"))
      this.plans.delete(plan)
      await this.reload()
    })
  }

  private assertOwnedPath(path: string, state: State): void {
    const roots = [this.home, ...Object.keys(state.repositories)]
    if (
      !isAbsolute(path) ||
      !roots.some((root) => {
        const rel = relative(root, path)
        return rel && !rel.startsWith("..") && !isAbsolute(rel)
      })
    )
      throw new Error(`Output is outside known roots: ${path}`)
    if (
      path === this.directory ||
      path.startsWith(`${this.directory}/`) ||
      path.split("/").includes(".git")
    )
      throw new Error(`Reserved output path: ${path}`)
  }

  private async recover(): Promise<void> {
    const path = join(this.directory, "journal.json")
    await assertSafePath(path)
    const raw = await readOptional(path)
    if (raw === null) return
    const journal = journalSchema.parse(JSON.parse(raw))
    const current = await readOptional(this.statePath)
    if (current === journal.after) {
      await unlink(path)
      return
    }
    if (current !== journal.before)
      throw new Error(
        "Cannot recover interrupted apply: state changed. Preserve ~/.loadout/journal.json for inspection.",
      )
    const state = stateSchema.parse(JSON.parse(journal.after))
    for (const change of journal.changes) {
      this.assertOwnedPath(change.path, state)
      await assertSafePath(change.path)
      const content = await readOptional(change.path)
      if (content !== change.before && content !== change.after)
        throw new Error(
          `Cannot recover a file edited after interruption: ${change.path}`,
        )
    }
    for (const change of [...journal.changes].reverse())
      await atomicWrite(change.path, change.before, change.beforeMode)
    await unlink(path)
  }

  private async locked<T>(action: () => Promise<T>): Promise<T> {
    await assertSafePath(this.statePath)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const path = join(this.directory, "lock")
    await assertSafePath(path)
    const ownership = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token: randomUUID(),
    })
    try {
      await writeFile(path, ownership, { flag: "wx", mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let lock: { pid?: number; host?: string } = {}
      try {
        lock = JSON.parse((await readOptional(path)) ?? "{}") ?? {}
      } catch {
        /* Preserve malformed locks for manual inspection. */
      }
      let stale = false
      if (
        lock.host === hostname() &&
        Number.isInteger(lock.pid) &&
        lock.pid! > 0
      ) {
        try {
          process.kill(lock.pid!, 0)
        } catch (error) {
          stale = (error as NodeJS.ErrnoException).code === "ESRCH"
        }
      }
      // Never reclaim automatically: a competing process could replace the lock between inspection and unlink.
      throw new Error(
        `${stale ? "An interrupted Loadout session left a stale lock" : "Another Loadout session may be applying changes"} (lock: ${path}). Close other Loadout sessions and verify no apply is running, then manually remove this lock file and retry. Keep journal.json; Loadout will recover it on retry.`,
      )
    }
    try {
      await this.recover()
      return await action()
    } finally {
      if ((await readOptional(path)) === ownership) await unlink(path)
    }
  }
}
