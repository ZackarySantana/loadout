import {
  chmod,
  lstat,
  mkdir,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { dirname, join, relative, isAbsolute, resolve } from "node:path"
import { hostname } from "node:os"
import { createHash, randomUUID } from "node:crypto"
import { outputSettingsSchema, type OutputSettings } from "../domain/settings"
import {
  defaultOutputSettings,
  inside,
  resolveDestinations,
  type ResolvedDestinationGroup,
} from "./settings"
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
  defaultRemoteSources,
  loadCatalog,
  loadCatalogListing,
  normalizeSource,
  type CatalogListing,
} from "./catalogs"
import { canonical, inspectDrift, sourceKit, type DriftReport } from "./drift"
import { sameSourceContent, stableReviewData } from "../domain/content-identity"
export type { DriftReport, KitDrift, KitDriftStatus, FileDrift } from "./drift"
import {
  assertSafePath,
  readOptional,
  readOptionalBytes,
  reconcile,
  assertSafeDirectory,
  snapshotNode,
  sameNode,
  nodeSnapshotSchema,
  type NodeSnapshot,
} from "./files"
import { renderState } from "./render"
import { agentPath, agentRoots } from "./subagents"
import { planOutputs } from "./outputs"
import { emptyState, stateSchema, type State } from "./state"
import {
  authorizeIgnoreTargets,
  planIgnores,
  type IgnorePlan,
  type IgnoreReport,
} from "./ignore"
export type { IgnoreReport, IgnoreTarget } from "./ignore"

export interface Selection {
  item: LoadedKit
  scope: Scope
  answers: Answers
  definition?: "catalog" | "saved"
  /** Update the active installation without replacing an independent Both fallback. */
  update?: boolean
}
export interface KitUpdate {
  key: string
  scope: Scope
  installed: LoadedKit
  latest: LoadedKit
  decision: "keep" | "update" | "remove"
}
export interface Change {
  path: string
  before: string | null
  after: string | null
  beforeKind?: NodeSnapshot["kind"]
  afterKind?: NodeSnapshot["kind"]
  beforeTarget?: string
  afterTarget?: string
}
export interface Plan {
  changes: readonly Change[]
  summary: string[]
  settings: OutputSettings
  previousSettings: OutputSettings
  settingsChanged: boolean
  resolvedLocations: ResolvedDestinationGroup[]
  ignore: IgnoreReport
  updates: KitUpdate[]
}
interface NodeChange extends Change {
  beforeNode: NodeSnapshot
  afterNode: NodeSnapshot
}
interface PlanData {
  before: string | null
  state: State
  changes: NodeChange[]
  sources: LoadedKit[]
  files: { path: string; before: NodeSnapshot }[]
  materializedSources: Set<string>
  linkSources: Set<string>
  ignore: IgnorePlan
  repositoryOutputs: Map<string, Set<string>>
  previousState: State
  updates: KitUpdate[]
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
      beforeNode: nodeSnapshotSchema.optional(),
      afterNode: nodeSnapshotSchema.optional(),
    }),
  ),
})

function displayNode(node: NodeSnapshot): string | null {
  return node.kind === "missing"
    ? null
    : node.kind === "file"
      ? node.content
      : `-> ${node.target}`
}

async function atomicNodeWrite(
  path: string,
  desired: NodeSnapshot,
  expected: NodeSnapshot,
): Promise<void> {
  await assertSafeDirectory(dirname(path))
  const check = async () => {
    if (
      !sameNode(await snapshotNode(path, expected.kind === "symlink"), expected)
    )
      throw new Error(
        `File or link changed since review; concurrent edits were preserved: ${path}`,
      )
  }
  await check()
  if (desired.kind === "missing") {
    if (expected.kind !== "missing") await unlink(path)
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await assertSafeDirectory(dirname(path))
  const temp = `${path}.loadout-${randomUUID()}`
  try {
    if (desired.kind === "symlink") await symlink(desired.target, temp)
    else {
      await writeFile(temp, desired.content, { flag: "wx", mode: 0o600 })
      await chmod(temp, desired.mode)
    }
    await check()
    await rename(temp, path)
  } finally {
    await unlink(temp).catch(() => {})
  }
}

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
  private readonly defaults: OutputSettings

  private constructor(
    home: string,
    repository: string,
    environment: Record<string, string | undefined>,
  ) {
    this.home = home
    this.repository = repository
    this.directory = join(home, ".loadout")
    this.statePath = join(this.directory, "state.json")
    this.defaults = defaultOutputSettings(home, environment)
  }

  static async open(options: {
    home: string
    repository: string
    environment?: Record<string, string | undefined>
  }): Promise<LoadoutService> {
    const service = new LoadoutService(
      await realpath(options.home),
      await realpath(options.repository),
      options.environment ?? process.env,
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
    const { catalogs, errors } = await loadCatalogListing(
      this.state.catalogs,
      this.repository,
    )
    return { catalogs, errors }
  }

  async browseCatalog(
    source: string,
    options?: { fresh?: boolean },
  ): Promise<Catalog> {
    await this.refresh()
    if (
      ![
        builtin,
        ...defaultRemoteSources,
        ...this.state.catalogs,
        join(this.repository, ".loadout/kits"),
      ].includes(source)
    )
      throw new Error("Catalog is not registered or automatic")
    const listing = await loadCatalogListing(
      this.state.catalogs,
      this.repository,
      {
        hydrateSources: [source],
        installed: this.installed(),
        forceRefresh: options?.fresh,
      },
    )
    const catalog = listing.catalogs.find(
      (catalog) => catalog.source === source,
    )
    if (!catalog)
      throw new Error(listing.failures.get(source) ?? "Catalog is unavailable")
    return structuredClone(catalog)
  }

  async status(options?: { fresh?: boolean }): Promise<{
    catalogs: Catalog[]
    errors: string[]
    drift: DriftReport
    settings: OutputSettings
    defaultSettings: OutputSettings
  }> {
    await this.refresh()
    const listing = await loadCatalogListing(
      this.state.catalogs,
      this.repository,
      { installed: this.installed(), forceRefresh: options?.fresh },
    )
    const drift = await inspectDrift(this.state, this.repository, listing)
    return structuredClone({
      catalogs: listing.catalogs,
      errors: listing.errors,
      drift,
      settings: this.settings(),
      defaultSettings: this.defaultSettings(),
    })
  }

  settings(): OutputSettings {
    const settings = structuredClone(this.state.settings ?? this.defaults)
    settings.agentLocations ??= structuredClone(this.defaults.agentLocations)
    return settings
  }
  defaultSettings(): OutputSettings {
    return structuredClone(this.defaults)
  }

  installed(): LoadedKit[] {
    const kits = {
      ...this.state.repositories[this.repository],
      ...this.state.global,
    }
    return structuredClone(
      Object.values(kits).map(({ key, kit, origin, installedAt }) => ({
        key,
        kit,
        ...(origin ? { origin } : {}),
        ...(installedAt ? { installedAt } : {}),
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
    scope: "repository" | "global" = "global",
  ): Promise<Catalog> {
    z.enum(["repository", "global"]).parse(scope)
    if (scope !== "global")
      throw new Error(
        "Repo is automatic: add kit YAML files to .loadout/kits/. External catalogs can only be registered globally.",
      )
    const normalized = await normalizeSource(source, this.repository)
    const catalog = await loadCatalog(
      normalized,
      false,
      { source: normalized, scope: "global" },
      { hydrateSources: [] },
    )
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
      if (this.state.catalogs.includes(normalized))
        throw new Error(`Catalog already registered globally: ${catalog.id}`)
      const next = structuredClone(this.state)
      next.catalogs.push(normalized)
      await atomicWrite(
        this.statePath,
        JSON.stringify(next, null, 2) + "\n",
        undefined,
        this.raw === null ? null : Buffer.from(this.raw),
      )
      await this.reload()
    })
    return (
      (await this.catalogs()).catalogs.find((c) => c.source === normalized) ??
      catalog
    )
  }

  async unregister(
    source: string,
    scope: "repository" | "global" = "global",
  ): Promise<void> {
    z.enum(["repository", "global"]).parse(scope)
    if (scope !== "global")
      throw new Error(
        "Repo is automatic: remove or rename kit YAML files in .loadout/kits/. External catalogs can only be unregistered globally.",
      )
    // Lexical resolution deliberately works even after the catalog was deleted.
    const lexical = source.startsWith("https://")
      ? new URL(source).href
      : resolve(this.repository, source)
    await this.locked(async () => {
      await this.reload()
      if (lexical === builtin)
        throw new Error("The built-in Loadout catalog is permanent")
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
          "Catalog is not registered globally; Repo is automatic and Loadout is permanent",
        )
      const next = structuredClone(this.state)
      next.catalogs = sources
      await atomicWrite(
        this.statePath,
        JSON.stringify(next, null, 2) + "\n",
        undefined,
        this.raw === null ? null : Buffer.from(this.raw),
      )
      await this.reload()
    })
  }

  async plan(
    selections: Selection[],
    settings?: OutputSettings,
  ): Promise<Plan> {
    // Snapshot caller-owned objects before the first await; later UI edits cannot alter a review.
    selections = structuredClone(selections)
    const candidateSettings =
      settings === undefined
        ? undefined
        : outputSettingsSchema.parse(structuredClone(settings))
    for (const selection of selections) {
      if (selection.definition !== undefined)
        selection.definition = z
          .enum(["catalog", "saved"])
          .parse(selection.definition)
      if (selection.update !== undefined)
        selection.update = z.boolean().parse(selection.update)
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
    const installed = this.installed()
    const listing = await loadCatalogListing(
      previous.catalogs,
      this.repository,
      {
        installed: [
          ...new Map(
            [
              ...installed,
              ...selections
                .filter(
                  (selection) =>
                    selection.definition !== "saved" &&
                    selection.scope !== "none",
                )
                .map((selection) => selection.item),
            ].map((item) => [canonical([item.origin?.source, item.key]), item]),
          ).values(),
        ],
        forceRefresh: true,
      },
    )
    const drift = await inspectDrift(previous, this.repository, listing)
    const updates: KitUpdate[] = drift.kits.flatMap((entry) => {
      const snapshot = installed.find((item) => item.key === entry.key)
      if (entry.status !== "changed" || !entry.latest || !snapshot) return []
      const selection = selections.find(
        (selection) => selection.item.key === entry.key,
      )
      return [
        {
          key: entry.key,
          scope: entry.scope,
          installed: snapshot,
          latest: entry.latest,
          decision:
            selection?.scope === "none"
              ? ("remove" as const)
              : selection && sameSourceContent(selection.item, entry.latest)
                ? ("update" as const)
                : ("keep" as const),
        },
      ]
    })
    const sourceCache = new Map<string, Promise<CatalogListing>>()
    sourceCache.set(this.repository, Promise.resolve(listing))
    for (const { item, scope, answers, definition, update } of selections) {
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
            (!item.origin || sameSourceContent(saved, item)),
        )
        if (definition === "saved" && !saved)
          throw new Error(`Saved snapshot is unavailable: ${item.key}`)
        if (saved && definition !== "catalog") {
          // Configuring an unchanged saved snapshot works offline and keeps its original provenance.
          item.origin = saved.origin
        } else {
          // Older callers may omit origin while editing a saved kit. Do not let that detach an update from its source.
          item.origin ??= (
            previous.global[item.key] ??
            previous.repositories[this.repository]?.[item.key]
          )?.origin
          const current = await sourceKit(
            item,
            listing,
            previous.catalogs,
            sourceCache,
          )
          // Untracked, originless programmatic kits remain supported; live catalog selections must match.
          if (item.origin || current.status !== "untracked") {
            if (
              current.status !== "current" ||
              (item.origin &&
                current.latest &&
                !sameSourceContent(item, current.latest))
            )
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
      if (scope === "global" || scope === "both")
        next.global[item.key] = structuredClone(config)
      else delete next.global[item.key]
      if (scope === "repository" || scope === "both") {
        const fallback = previous.repositories[this.repository]?.[item.key]
        repo[item.key] =
          update && scope === "both" && previous.global[item.key] && fallback
            ? structuredClone(fallback)
            : structuredClone(config)
      } else delete repo[item.key]
      summary.push(
        `${item.kit.name}: ${scope === "none" ? "remove from global and this repository" : scope}`,
      )
      if (
        update &&
        scope === "both" &&
        previous.global[item.key] &&
        previous.repositories[this.repository]?.[item.key]
      )
        summary.push(
          `${item.kit.name}: update the active global installation; retain this repository's independent fallback definition and answers`,
        )
    }
    const previousSettings = this.settings()
    const effectiveSettings = structuredClone(
      candidateSettings ?? previousSettings,
    )
    effectiveSettings.agentLocations ??= structuredClone(
      previousSettings.agentLocations,
    )
    // Validate repository lists even when no repository intent exists yet.
    resolveDestinations(effectiveSettings, this.home, [
      ...Object.keys(next.repositories),
      this.repository,
    ])
    next.settings = structuredClone(effectiveSettings)
    const repositoryOutputs = new Map<string, Set<string>>()
    next.managed = renderState(
      next,
      this.home,
      effectiveSettings,
      repositoryOutputs,
    )
    const ignore = await planIgnores(
      effectiveSettings.ignore,
      repositoryOutputs,
      this.repository,
      previous,
    )
    for (const [path, managed] of Object.entries(ignore.managed)) {
      if (
        next.managed[path] ||
        Object.keys(next.managed).some(
          (output) => inside(output, path) || inside(path, output),
        )
      )
        throw new Error(`Managed output conflicts with ignore target: ${path}`)
      next.managed[path] = structuredClone(managed)
    }
    const ignorePaths = await authorizeIgnoreTargets([previous, next])
    for (const path of new Set([
      ...Object.keys(previous.managed),
      ...Object.keys(next.managed),
    ]))
      this.assertOwnedPath(path, next, previous, ignorePaths)
    const nodes = await planOutputs(previous.managed, next.managed)
    const changes: NodeChange[] = []
    const files = [...nodes.before].map(([path, before]) => ({ path, before }))
    for (const [path, beforeNode] of nodes.before) {
      const afterNode = nodes.after.get(path)!
      if (!sameNode(beforeNode, afterNode))
        changes.push({
          path,
          before: displayNode(beforeNode),
          after: displayNode(afterNode),
          beforeKind: beforeNode.kind,
          afterKind: afterNode.kind,
          ...(beforeNode.kind === "symlink"
            ? { beforeTarget: beforeNode.target }
            : {}),
          ...(afterNode.kind === "symlink"
            ? { afterTarget: afterNode.target }
            : {}),
          beforeNode,
          afterNode,
        })
    }
    // Materialize all real files before links; retire obsolete sources last.
    const rank = (change: NodeChange) =>
      change.afterNode.kind === "file"
        ? 0
        : change.afterNode.kind === "symlink"
          ? 1
          : 2
    changes.sort((a, b) => rank(a) - rank(b))
    const settingsChanged =
      canonical(previousSettings) !== canonical(effectiveSettings)
    if (settingsChanged)
      summary.push(
        "Update output settings for all known repositories and global selections",
      )
    const plan: Plan = {
      changes: changes.map(
        ({ beforeNode: _before, afterNode: _after, ...change }) =>
          structuredClone(change),
      ),
      summary: structuredClone(summary),
      settings: structuredClone(effectiveSettings),
      previousSettings: structuredClone(previousSettings),
      settingsChanged,
      resolvedLocations: resolveDestinations(effectiveSettings, this.home, [
        ...Object.keys(next.repositories),
        this.repository,
      ]),
      ignore: structuredClone(ignore.report),
      updates: structuredClone(updates),
    }
    this.plans.set(plan, {
      before: beforeState,
      state: next,
      changes,
      sources,
      files,
      ignore: structuredClone(ignore),
      repositoryOutputs: structuredClone(repositoryOutputs),
      previousState: structuredClone(previous),
      updates: structuredClone(updates),
      materializedSources: new Set(
        Object.entries(previous.managed).flatMap(([path, managed]) =>
          managed.type === "symlink" &&
          next.managed[path] &&
          next.managed[path]?.type !== "symlink"
            ? [managed.source]
            : [],
        ),
      ),
      linkSources: new Set(
        [
          ...Object.values(previous.managed),
          ...Object.values(next.managed),
        ].flatMap((managed) =>
          managed.type === "symlink" ? [managed.source] : [],
        ),
      ),
    })
    return plan
  }

  /** Bind a cross-process CLI review to privately captured intent and file guards. */
  reviewDigest(plan: Plan): string {
    const data = this.plans.get(plan)
    if (!data)
      throw new Error("This review belongs to a different Loadout session")
    return createHash("sha256")
      .update(
        canonical(
          stableReviewData({
            home: this.home,
            repository: this.repository,
            before: data.before,
            state: data.state,
            changes: data.changes,
            sources: data.sources,
            updates: data.updates,
            files: data.files,
            materializedSources: [...data.materializedSources].sort(),
            linkSources: [...data.linkSources].sort(),
            ignore: data.ignore,
            repositoryOutputs: [...data.repositoryOutputs]
              .map(([root, paths]) => [root, [...paths].sort()])
              .sort(([a], [b]) => String(a).localeCompare(String(b))),
          }),
        ),
      )
      .digest("hex")
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
        const listing = await loadCatalogListing(
          this.state.catalogs,
          this.repository,
          { installed: data.sources, forceRefresh: true },
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
          if (
            current.status !== "current" ||
            !current.latest ||
            !sameSourceContent(item, current.latest)
          )
            throw new Error(
              `Kit source changed since review; review again: ${item.key}: ${current.reason}`,
            )
        }
      }
      const checkIgnoreContext = async () => {
        const current = await planIgnores(
          data.state.settings!.ignore,
          data.repositoryOutputs,
          this.repository,
          data.previousState,
        )
        if (
          canonical(current.report) !== canonical(data.ignore.report) ||
          canonical(current.contexts) !== canonical(data.ignore.contexts)
        )
          throw new Error(
            "Git worktree, exclude target, or tracked managed paths changed since review. Review again before applying.",
          )
        return authorizeIgnoreTargets([data.previousState, data.state])
      }
      const ignorePaths = await checkIgnoreContext()
      const expectedNodes = new Map<string, NodeSnapshot>()
      for (const change of data.files) {
        const current = await snapshotNode(
          change.path,
          change.before.kind === "symlink",
        )
        if (!sameNode(current, change.before)) {
          const managed = data.state.managed[change.path]
          if (
            current.kind !== "file" ||
            change.before.kind !== "file" ||
            current.mode !== change.before.mode ||
            managed?.type !== "instructions" ||
            data.materializedSources.has(change.path) ||
            data.changes.some((file) => file.path === change.path)
          )
            throw new Error(
              `File changed since review; review again (including link targets): ${change.path}`,
            )
          // Preserve unrelated edits on untouched instruction files, unless their bytes were copied elsewhere.
          reconcile(
            change.path,
            current.content,
            managed,
            structuredClone(managed),
          )
        }
        expectedNodes.set(change.path, current)
      }
      const committed = structuredClone(data.state)
      const installedAt = new Date().toISOString()
      const stamp = (
        configs: State["global"],
        previous: State["global"] = {},
      ) => {
        for (const [key, config] of Object.entries(configs)) {
          const saved = previous[key]
          if (saved && sameSourceContent(saved, config)) {
            if (saved.installedAt) config.installedAt = saved.installedAt
            else delete config.installedAt
          } else config.installedAt = installedAt
        }
      }
      stamp(committed.global, data.previousState.global)
      for (const [repository, configs] of Object.entries(
        committed.repositories,
      ))
        stamp(configs, data.previousState.repositories[repository])
      const after = JSON.stringify(committed, null, 2) + "\n"
      const changes = data.changes
      const journal = { before: data.before, after, changes }
      await atomicWrite(
        join(this.directory, "journal.json"),
        JSON.stringify(journal),
      )
      try {
        const checkSources = async () => {
          for (const path of data.linkSources) {
            const expected = expectedNodes.get(path)!
            if (
              !sameNode(
                await snapshotNode(path, expected.kind === "symlink"),
                expected,
              )
            )
              throw new Error(
                `Link source changed during apply; concurrent edits were preserved: ${path}`,
              )
          }
        }
        for (const change of data.changes) {
          await checkSources()
          if (ignorePaths.has(change.path)) {
            await checkIgnoreContext()
            this.assertOwnedPath(
              change.path,
              data.state,
              data.previousState,
              ignorePaths,
            )
          }
          await atomicNodeWrite(
            change.path,
            change.afterNode,
            change.beforeNode,
          )
          expectedNodes.set(change.path, change.afterNode)
        }
        await checkSources()
        await atomicWrite(
          this.statePath,
          after,
          undefined,
          data.before === null ? null : Buffer.from(data.before),
        )
      } catch (error) {
        await this.recover()
        throw error
      }
      await unlink(join(this.directory, "journal.json"))
      this.plans.delete(plan)
      await this.reload()
    })
  }

  private assertOwnedPath(
    path: string,
    state: State,
    previous?: State,
    ignorePaths = new Set<string>(),
  ): void {
    const managed = state.managed[path] ?? previous?.managed[path]
    if (managed?.type === "ignore") {
      if (!ignorePaths.has(path))
        throw new Error(
          `Ignore target was not authorized for a known repository: ${path}`,
        )
      return
    }
    const roots = [this.home, ...Object.keys(state.repositories)]
    const configured = resolveDestinations(
      state.settings ?? this.defaults,
      this.home,
      Object.keys(state.repositories),
    )
    const nativeRoots = agentRoots(
      state.settings ?? this.defaults,
      this.home,
      this.home,
      true,
    )
    const nativeDestination = Object.values(state.global).some((config) =>
      config.kit.outputs.some(
        (output) =>
          output.type === "agent" &&
          output.harnesses.some(
            (harness) =>
              agentPath(nativeRoots[harness], output.name, harness) === path,
          ),
      ),
    )
    const explicitDestination =
      nativeDestination ||
      configured.some((group) =>
        group.locations.some((location) =>
          group.kind === "instructions"
            ? path === location
            : inside(location, path),
        ),
      )
    if (
      !isAbsolute(path) ||
      (!explicitDestination &&
        !previous?.managed[path] &&
        !roots.some((root) => {
          const rel = relative(root, path)
          return rel && !rel.startsWith("..") && !isAbsolute(rel)
        }))
    )
      throw new Error(`Output is outside known roots: ${path}`)
    if (
      path === this.directory ||
      path.startsWith(`${this.directory}/`) ||
      path.split("/").some((part) => part === ".git" || part === ".loadout")
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
    const previous =
      journal.before === null
        ? emptyState()
        : stateSchema.parse(JSON.parse(journal.before))
    const ignorePaths = await authorizeIgnoreTargets([previous, state])
    const changes = journal.changes.map((change) => ({
      ...change,
      legacy: change.beforeNode === undefined && change.afterNode === undefined,
      beforeNode:
        change.beforeNode ??
        (change.before === null
          ? { kind: "missing" as const }
          : {
              kind: "file" as const,
              content: change.before,
              mode: change.beforeMode ?? 0o600,
            }),
      afterNode:
        change.afterNode ??
        (change.after === null
          ? { kind: "missing" as const }
          : {
              kind: "file" as const,
              content: change.after,
              mode: change.beforeMode ?? 0o600,
            }),
    }))
    const matchesRecoveryNode = (
      current: NodeSnapshot,
      expected: NodeSnapshot,
      legacy: boolean,
    ) =>
      sameNode(current, expected) ||
      (legacy &&
        current.kind === "file" &&
        expected.kind === "file" &&
        current.content === expected.content)
    for (const change of changes) {
      this.assertOwnedPath(change.path, state, previous, ignorePaths)
      const content = await snapshotNode(
        change.path,
        change.beforeNode.kind === "symlink" ||
          change.afterNode.kind === "symlink",
      )
      if (
        !matchesRecoveryNode(content, change.beforeNode, change.legacy) &&
        !matchesRecoveryNode(content, change.afterNode, change.legacy)
      )
        throw new Error(
          `Cannot recover a file edited after interruption: ${change.path}`,
        )
    }
    // Restore regular sources before links, and remove newly created leaves last.
    const rank = (node: NodeSnapshot) =>
      node.kind === "file" ? 0 : node.kind === "symlink" ? 1 : 2
    for (const change of [...changes].sort(
      (a, b) => rank(a.beforeNode) - rank(b.beforeNode),
    )) {
      const current = await snapshotNode(
        change.path,
        change.beforeNode.kind === "symlink" ||
          change.afterNode.kind === "symlink",
      )
      if (sameNode(current, change.beforeNode)) continue
      if (
        !matchesRecoveryNode(current, change.beforeNode, change.legacy) &&
        !matchesRecoveryNode(current, change.afterNode, change.legacy)
      )
        throw new Error(
          `Cannot recover a file edited after interruption: ${change.path}`,
        )
      if (ignorePaths.has(change.path)) {
        const currentIgnorePaths = await authorizeIgnoreTargets([
          previous,
          state,
        ])
        this.assertOwnedPath(change.path, state, previous, currentIgnorePaths)
      }
      await atomicNodeWrite(change.path, change.beforeNode, current)
    }
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
