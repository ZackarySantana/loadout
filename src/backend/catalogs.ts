import { readFile, readdir, realpath, stat } from "node:fs/promises"
import { dirname, resolve, relative, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseDocument } from "yaml"
import {
  catalogSchema,
  kitSchema,
  type Catalog,
  type CatalogOrigin,
  type Kit,
  type LoadedKit,
} from "../domain/kit"
import { repositoryCatalogId } from "../domain/catalog"
import { assertSafeDirectory } from "./files"

declare const LOADOUT_BUNDLED: boolean
export const builtin = fileURLToPath(
  new URL(
    typeof LOADOUT_BUNDLED !== "undefined" && LOADOUT_BUNDLED
      ? "../catalog/catalog.json"
      : "../../catalog/catalog.json",
    import.meta.url,
  ),
)
const maxSize = 2_000_000

async function readSource(source: string): Promise<string> {
  if (source.startsWith("https://")) {
    const response = await fetch(source, {
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    })
    if (!response.ok)
      throw new Error(`Cannot read ${source}: HTTP ${response.status}`)
    const reader = response.body!.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > maxSize)
          throw new Error(`Source exceeds ${maxSize} bytes: ${source}`)
        chunks.push(value)
      }
    } finally {
      await reader.cancel()
    }
    return Buffer.concat(chunks).toString("utf8")
  }
  if (/^[a-z]+:/i.test(source))
    throw new Error("Catalog sources must be local paths or HTTPS URLs")
  const info = await stat(source)
  if (!info.isFile()) throw new Error(`Source is not a regular file: ${source}`)
  if (info.size > maxSize) throw new Error(`Source is too large: ${source}`)
  const text = await readFile(source, "utf8")
  if (Buffer.byteLength(text) > maxSize)
    throw new Error(`Source is too large: ${source}`)
  return text
}

function parseKit(text: string): Kit {
  const doc = parseDocument(text, { uniqueKeys: true })
  if (doc.errors.length)
    throw new Error(doc.errors.map((error) => error.message).join("\n"))
  return kitSchema.parse(doc.toJS({ maxAliasCount: 20 }))
}

export async function normalizeSource(
  source: string,
  cwd: string,
): Promise<string> {
  if (source.startsWith("https://")) return new URL(source).href
  if (/^[a-z]+:/i.test(source)) throw new Error("Use a local path or HTTPS URL")
  return realpath(resolve(cwd, source))
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)
}

async function kitSource(
  catalogSource: string,
  reference: string,
): Promise<string> {
  if (catalogSource.startsWith("https://")) {
    const base = new URL(".", catalogSource)
    const url = new URL(reference, base)
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
      throw new Error(
        "Kit references must stay within the catalog directory and origin",
      )
    return url.href
  }
  const base = await realpath(dirname(catalogSource))
  const path = await realpath(resolve(base, reference))
  if (!within(base, path))
    throw new Error("Kit references must stay within the catalog directory")
  return path
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function loadCatalog(
  source: string,
  permanent = false,
  origin?: CatalogOrigin,
): Promise<Catalog> {
  const catalog = catalogSchema.parse(JSON.parse(await readSource(source)))
  if (
    !permanent &&
    (catalog.id === "loadout" || /^repo-[a-f0-9]{64}$/.test(catalog.id))
  )
    throw new Error("The Loadout and automatic Repo catalog IDs are reserved")
  const unavailableKits: NonNullable<Catalog["unavailableKits"]> = []
  const results = await Promise.all(
    catalog.kits.map(async (entry) => {
      try {
        const kit = parseKit(
          await readSource(await kitSource(source, entry.source)),
        )
        if (kit.id !== entry.id)
          throw new Error(
            `Kit ID mismatch: expected ${entry.id}, got ${kit.id}`,
          )
        return {
          key: `${catalog.id}/${kit.id}`,
          kit,
          origin: origin ? { ...origin, catalogId: catalog.id } : undefined,
        }
      } catch (error) {
        unavailableKits.push({
          ...entry,
          key: `${catalog.id}/${entry.id}`,
          reason: message(error),
        })
        return undefined
      }
    }),
  )
  unavailableKits.sort(
    (a, b) =>
      catalog.kits.findIndex((kit) => kit.id === a.id) -
      catalog.kits.findIndex((kit) => kit.id === b.id),
  )
  return {
    id: catalog.id,
    name: catalog.name,
    kits: results.filter((item) => item !== undefined),
    unavailableKits,
    issues: unavailableKits.map((item) => `${item.key}: ${item.reason}`),
    source,
    permanent,
    kind: permanent ? "builtin" : "external",
  }
}

export interface RepoFile {
  key?: string
  reason?: string
}
export interface CatalogListing {
  catalogs: Catalog[]
  errors: string[]
  failures: Map<string, string>
  repoInventory: Map<string, RepoFile>
}

/** Flat live directory discovery. No project index or subscription file is consulted. */
export async function loadRepositoryCatalog(repository: string): Promise<{
  catalog: Catalog
  inventory: Map<string, RepoFile>
  failure?: string
}> {
  const source = join(repository, ".loadout/kits")
  const id = repositoryCatalogId(repository)
  const catalog: Catalog = {
    id,
    name: "Repo",
    source,
    permanent: true,
    automatic: true,
    kind: "repo",
    kits: [],
    unavailableKits: [],
    issues: [],
  }
  const inventory = new Map<string, RepoFile>()
  let files: string[]
  try {
    await assertSafeDirectory(source)
    files = (await readdir(source))
      .filter((file) => /\.ya?ml$/i.test(file))
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { catalog, inventory }
    const failure = message(error)
    catalog.issues!.push(failure)
    return { catalog, inventory, failure }
  }
  const candidates: { file: string; item: LoadedKit }[] = []
  for (const file of files) {
    try {
      if (file.includes("\\"))
        throw new Error("Repo kit filenames must not contain backslashes")
      const path = await realpath(join(source, file))
      if (!within(source, path) || !within(repository, path))
        throw new Error(
          "Repo kit symlinks must stay within .loadout/kits and the checkout",
        )
      const kit = parseKit(await readSource(path))
      const key = `${id}/${kit.id}`
      inventory.set(file, { key })
      candidates.push({
        file,
        item: {
          key,
          kit,
          origin: {
            catalogId: id,
            source,
            scope: "repository",
            repository,
            file,
          },
        },
      })
    } catch (error) {
      const reason = message(error)
      inventory.set(file, { reason })
      catalog.unavailableKits!.push({ name: file, source: file, reason })
      catalog.issues!.push(`${file}: ${reason}`)
    }
  }
  const counts = new Map<string, number>()
  for (const { item } of candidates)
    counts.set(item.key, (counts.get(item.key) ?? 0) + 1)
  for (const { file, item } of candidates) {
    if (counts.get(item.key)! > 1) {
      const reason = `Duplicate Repo kit ID: ${item.kit.id}; resolve all conflicting files before selecting this kit`
      inventory.set(file, { key: item.key, reason })
      catalog.unavailableKits!.push({
        key: item.key,
        id: item.kit.id,
        name: item.kit.name,
        source: file,
        reason,
      })
      catalog.issues!.push(`${file}: ${reason}`)
    } else catalog.kits.push(item)
  }
  return { catalog, inventory }
}

export async function loadCatalogListing(
  globalSources: string[],
  repository?: string,
): Promise<CatalogListing> {
  const catalogs: Catalog[] = []
  const errors: string[] = []
  const failures = new Map<string, string>()
  let repoInventory = new Map<string, RepoFile>()
  if (repository) {
    const result = await loadRepositoryCatalog(repository)
    catalogs.push(result.catalog)
    repoInventory = result.inventory
    if (result.failure) failures.set(result.catalog.source, result.failure)
    errors.push(
      ...(result.catalog.issues ?? []).map(
        (issue) => `${result.catalog.source}: ${issue}`,
      ),
    )
  }
  try {
    const catalog = await loadCatalog(builtin, true, {
      source: builtin,
      scope: "global",
      catalogId: "loadout",
    })
    catalogs.push({ ...catalog, automatic: true })
    errors.push(
      ...(catalog.issues ?? []).map((issue) => `${builtin}: ${issue}`),
    )
  } catch (error) {
    failures.set(builtin, message(error))
    errors.push(`${builtin}: ${message(error)}`)
  }
  for (const source of new Set(globalSources)) {
    try {
      const catalog = await loadCatalog(source, false, {
        source,
        scope: "global",
      })
      if (catalogs.some((c) => c.id === catalog.id))
        throw new Error(
          `Conflicting catalog ID ${catalog.id} from different sources; refusing ${source}`,
        )
      catalogs.push(catalog)
      errors.push(
        ...(catalog.issues ?? []).map((issue) => `${source}: ${issue}`),
      )
    } catch (error) {
      failures.set(source, message(error))
      errors.push(`${source}: ${message(error)}`)
    }
  }
  return { catalogs, errors, failures, repoInventory }
}

/** Origin checks outside the active checkout need only its automatic directory inventory. */
export async function loadRepositoryListing(
  repository: string,
): Promise<CatalogListing> {
  const { catalog, inventory, failure } =
    await loadRepositoryCatalog(repository)
  return {
    catalogs: [catalog],
    errors: (catalog.issues ?? []).map(
      (issue) => `${catalog.source}: ${issue}`,
    ),
    failures: failure ? new Map([[catalog.source, failure]]) : new Map(),
    repoInventory: inventory,
  }
}

export async function loadCatalogs(
  sources: string[],
): Promise<{ catalogs: Catalog[]; errors: string[] }> {
  const { catalogs, errors } = await loadCatalogListing(sources)
  return { catalogs, errors }
}
