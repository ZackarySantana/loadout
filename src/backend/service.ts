import {
  chmod,
  lstat,
  mkdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import { dirname, join, relative, isAbsolute, resolve } from "node:path"
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
  catalogOriginSchema,
  validateAnswers,
} from "../domain/kit"
import {
  builtin,
  loadCatalog,
  loadSubscriptions,
  normalizeSource,
  readRepositoryManifestSnapshot,
  repositorySource,
  type CatalogListing,
} from "./catalogs"
import { canonical, inspectDrift, sourceKit, type DriftReport } from "./drift"
export type { DriftReport, KitDrift, KitDriftStatus, FileDrift } from "./drift"
import {
  assertSafePath,
  readOptional,
  readOptionalBytes,
  reconcile,
} from "./files"
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
  sources: LoadedKit[]
  files: { path: string; before: string | null }[]
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
  expectedBefore?: Buffer | null,
): Promise<void> {
  await assertSafePath(path)
  const checkBefore = async () => {
    await assertSafePath(path)
    if (expectedBefore === undefined) return
    const current = await readOptionalBytes(path)
    if (
      expectedBefore === null
        ? current !== null
        : current === null || !expectedBefore.equals(current)
    )
      throw new Error(
        `Configuration changed while editing; concurrent edits were preserved. Retry the operation: ${path}`,
      )
  }
  if (content === null) {
    await checkBefore()
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
    // Best-effort stale-write protection, not an OS-level compare-and-swap.
    await checkBefore()
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
    const { catalogs, errors } = await loadSubscriptions(
      this.state.catalogs,
      this.repository,
    )
    return { catalogs, errors }
  }

  async status(): Promise<{
    catalogs: Catalog[]
    errors: string[]
    drift: DriftReport
  }> {
    await this.refresh()
    const listing = await loadSubscriptions(
      this.state.catalogs,
      this.repository,
    )
    const drift = await inspectDrift(this.state, this.repository, listing)
    return structuredClone({
      catalogs: listing.catalogs,
      errors: listing.errors,
      drift,
    })
  }

  installed(): LoadedKit[] {
    const kits = {
      ...this.state.repositories[this.repository],
      ...this.state.global,
    }
    return structuredClone(
      Object.values(kits).map(({ key, kit, origin }) => ({
        key,
        kit,
        ...(origin ? { origin } : {}),
      })),
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

  async register(
    source: string,
    scope: "repository" | "global" = "repository",
  ): Promise<Catalog> {
    z.enum(["repository", "global"]).parse(scope)
    const normalized =
      scope === "repository"
        ? await repositorySource(source, this.repository)
        : await normalizeSource(source, this.repository)
    const catalog = await loadCatalog(normalized, false, {
      source: normalized,
      scope,
      repository: scope === "repository" ? this.repository : undefined,
    })
    await this.locked(async () => {
      await this.reload()
      const existing = await this.catalogs()
      if (
        existing.catalogs.some(
          (c) => c.id === catalog.id && c.source !== normalized,
        )
      )
        throw new Error(
          `Conflicting catalog ID from different sources: ${catalog.id}`,
        )
      if (scope === "repository") {
        if (
          normalized === join(this.repository, ".loadout/catalog.json") ||
          existing.catalogs.some((c) => c.source === normalized && c.automatic)
        )
          throw new Error(
            "This catalog is discovered automatically; no registration is needed",
          )
        await this.editRepositoryManifest(async (sources) => {
          for (const reference of sources) {
            if (
              (await repositorySource(reference, this.repository, false)) ===
              normalized
            )
              throw new Error(
                `Catalog already registered in repository: ${catalog.id}`,
              )
          }
          sources.push(
            normalized.startsWith("https://")
              ? normalized
              : relative(this.repository, normalized),
          )
          return sources
        })
      } else {
        if (this.state.catalogs.includes(normalized))
          throw new Error(`Catalog already registered globally: ${catalog.id}`)
        this.state.catalogs.push(normalized)
        await atomicWrite(
          this.statePath,
          JSON.stringify(this.state, null, 2) + "\n",
        )
      }
      await this.reload()
    })
    return (
      (await this.catalogs()).catalogs.find((c) => c.source === normalized) ??
      catalog
    )
  }

  async unregister(
    source: string,
    scope: "repository" | "global" = "repository",
  ): Promise<void> {
    z.enum(["repository", "global"]).parse(scope)
    // Lexical resolution deliberately works even after the catalog was deleted.
    const lexical = source.startsWith("https://")
      ? new URL(source).href
      : resolve(this.repository, source)
    await this.locked(async () => {
      await this.reload()
      if (lexical === builtin)
        throw new Error("The built-in Loadout catalog is permanent")
      if (scope === "repository") {
        let normalized = lexical
        try {
          normalized = await repositorySource(source, this.repository, false)
        } catch {
          /* Missing or unsafe subscriptions can be removed lexically. */
        }
        let conventional = join(this.repository, ".loadout/catalog.json")
        try {
          conventional = await repositorySource(conventional, this.repository)
        } catch {
          /* The lexical conventional path is still reserved when missing. */
        }
        if (
          lexical === join(this.repository, ".loadout/catalog.json") ||
          conventional === normalized
        )
          throw new Error(
            "The conventional catalog is discovered automatically; remove or rename .loadout/catalog.json to stop sharing it",
          )
        await this.editRepositoryManifest(async (sources) => {
          let found = false
          const remaining: string[] = []
          for (const reference of sources) {
            const path = reference.startsWith("https://")
              ? new URL(reference).href
              : resolve(this.repository, reference)
            let matches = path === lexical
            if (!matches) {
              try {
                matches =
                  (await repositorySource(
                    reference,
                    this.repository,
                    false,
                  )) ===
                  (await repositorySource(source, this.repository, false))
              } catch {
                /* Missing/unsafe references can still be removed by their stored spelling. */
              }
            }
            if (matches) found = true
            else remaining.push(reference)
          }
          if (!found)
            throw new Error("Catalog is not registered in this repository")
          return remaining
        })
      } else {
        let normalized = lexical
        try {
          normalized = await normalizeSource(source, this.repository)
        } catch {
          /* Missing global source. */
        }
        const sources = this.state.catalogs.filter(
          (s) => s !== normalized && s !== lexical,
        )
        if (sources.length === this.state.catalogs.length)
          throw new Error(
            "Catalog is not registered globally; Loadout is permanent",
          )
        this.state.catalogs = sources
        await atomicWrite(
          this.statePath,
          JSON.stringify(this.state, null, 2) + "\n",
        )
      }
      await this.reload()
    })
  }

  private async editRepositoryManifest(
    edit: (sources: string[]) => Promise<string[]>,
  ): Promise<void> {
    const path = join(this.repository, ".loadout/catalogs.json")
    const lock = `${path}.lock`
    await assertSafePath(path)
    await assertSafePath(lock)
    await mkdir(dirname(path), { recursive: true })
    const token = randomUUID()
    await writeFile(lock, token, { flag: "wx", mode: 0o600 })
    try {
      const { manifest, raw } = await readRepositoryManifestSnapshot(
        this.repository,
      )
      const catalogs = await edit([...manifest.catalogs])
      await atomicWrite(
        path,
        JSON.stringify({ catalogs }, null, 2) + "\n",
        undefined,
        raw,
      )
    } finally {
      await assertSafePath(lock)
      if ((await readOptional(lock)) === token) await unlink(lock)
    }
  }

  async plan(selections: Selection[]): Promise<Plan> {
    // Snapshot caller-owned objects before the first await; later UI edits cannot alter a review.
    selections = structuredClone(selections)
    for (const selection of selections) {
      selection.item.kit = kitSchema.parse(selection.item.kit)
      if (selection.item.origin)
        selection.item.origin = catalogOriginSchema.parse(selection.item.origin)
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
    const sources: LoadedKit[] = []
    let listing: CatalogListing | undefined
    const sourceCache = new Map<string, Promise<CatalogListing>>()
    for (const { item, scope, answers } of selections) {
      if (seen.has(item.key))
        throw new Error(`Duplicate selection: ${item.key}`)
      if (
        !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(item.key) ||
        !item.key.endsWith(`/${item.kit.id}`)
      )
        throw new Error(`Invalid kit identity: ${item.key}`)
      seen.add(item.key)
      if (scope !== "none") {
        const snapshots = [
          previous.global[item.key],
          previous.repositories[this.repository]?.[item.key],
        ]
        const saved = snapshots.find(
          (saved) =>
            saved &&
            canonical(saved.kit) === canonical(item.kit) &&
            (!item.origin ||
              canonical(saved.origin) === canonical(item.origin)),
        )
        if (saved) {
          // Configuring an unchanged saved snapshot works offline and keeps its original provenance.
          item.origin = saved.origin
        } else {
          // Older callers may omit origin while editing a saved kit. Do not let that detach an update from its source.
          item.origin ??= (
            previous.global[item.key] ??
            previous.repositories[this.repository]?.[item.key]
          )?.origin
          listing ??= await loadSubscriptions(
            previous.catalogs,
            this.repository,
          )
          sourceCache.set(this.repository, Promise.resolve(listing))
          const current = await sourceKit(
            item,
            listing,
            previous.catalogs,
            sourceCache,
          )
          // Untracked, originless programmatic kits remain supported; live catalog selections must match.
          if (item.origin || current.status !== "untracked") {
            if (current.status !== "current")
              throw new Error(
                `Kit source changed or is unavailable; select and review its current definition: ${item.key}: ${current.reason}`,
              )
            item.origin = current.latest?.origin
            sources.push(structuredClone(item))
          }
        }
      }
      const config: ConfiguredKit = {
        key: item.key,
        kit: item.kit,
        answers: scope === "none" ? {} : validateAnswers(item.kit, answers),
        ...(item.origin ? { origin: item.origin } : {}),
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
    const files: { path: string; before: string | null }[] = []
    for (const path of new Set([
      ...Object.keys(previous.managed),
      ...Object.keys(next.managed),
    ])) {
      this.assertOwnedPath(path, next)
      await assertSafePath(path)
      const before = await readOptional(path)
      files.push({ path, before })
      const after = reconcile(
        path,
        before,
        previous.managed[path],
        next.managed[path],
      )
      if (before !== after) changes.push({ path, before, after })
    }
    const plan: Plan = { changes: structuredClone(changes), summary }
    this.plans.set(plan, {
      before: beforeState,
      state: next,
      changes,
      sources,
      files,
    })
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
      if (data.sources.length) {
        const listing = await loadSubscriptions(
          this.state.catalogs,
          this.repository,
        )
        const cache = new Map<string, Promise<CatalogListing>>([
          [this.repository, Promise.resolve(listing)],
        ])
        for (const item of data.sources) {
          const current = await sourceKit(
            item,
            listing,
            this.state.catalogs,
            cache,
          )
          if (current.status !== "current")
            throw new Error(
              `Kit source changed since review; review again: ${item.key}: ${current.reason}`,
            )
        }
      }
      for (const change of data.files) {
        await assertSafePath(change.path)
        const current = await readOptional(change.path)
        if (current !== change.before) {
          const managed = data.state.managed[change.path]
          if (
            data.changes.some((file) => file.path === change.path) ||
            !managed
          )
            throw new Error(
              `File changed since review; review again: ${change.path}`,
            )
          // No write is planned here: unrelated instruction text may change, but managed blocks may not.
          reconcile(change.path, current, managed, structuredClone(managed))
        }
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
