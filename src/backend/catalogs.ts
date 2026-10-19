import { lstat, readFile, realpath, stat } from "node:fs/promises"
import { dirname, resolve, relative, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseDocument } from "yaml"
import { z } from "zod"
import {
  catalogSchema,
  kitSchema,
  type Catalog,
  type CatalogOrigin,
} from "../domain/kit"
import { assertSafePath, readOptionalBytes } from "./files"

// The bundled entry point lives one directory below the catalog assets.
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

export async function normalizeSource(
  source: string,
  cwd: string,
): Promise<string> {
  if (source.startsWith("https://")) return new URL(source).href
  if (/^[a-z]+:/i.test(source)) throw new Error("Use a local path or HTTPS URL")
  return realpath(resolve(cwd, source))
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
  const rel = relative(base, path)
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Kit references must stay within the catalog directory")
  return path
}

export async function loadCatalog(
  source: string,
  permanent = false,
  origin?: CatalogOrigin,
): Promise<Catalog> {
  const catalog = catalogSchema.parse(JSON.parse(await readSource(source)))
  if (!permanent && catalog.id === "loadout")
    throw new Error("The Loadout catalog ID is reserved")
  const unavailableKits: NonNullable<Catalog["unavailableKits"]> = []
  const results = await Promise.all(
    catalog.kits.map(async (entry) => {
      try {
        const text = await readSource(await kitSource(source, entry.source))
        const doc = parseDocument(text, { uniqueKeys: true })
        if (doc.errors.length)
          throw new Error(doc.errors.map((e) => e.message).join("\n"))
        const kit = kitSchema.parse(doc.toJS({ maxAliasCount: 20 }))
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
    description: catalog.description,
    kits: results.filter((item) => item !== undefined),
    unavailableKits,
    issues: unavailableKits.map((item) => `${item.key}: ${item.reason}`),
    source,
    permanent,
  }
}

export async function loadCatalogs(
  sources: string[],
): Promise<{ catalogs: Catalog[]; errors: string[] }> {
  const { catalogs, errors } = await loadSubscriptions(sources, undefined)
  return { catalogs, errors }
}

export const repositoryManifestSchema = z
  .object({ catalogs: z.array(z.string().min(1)) })
  .strict()
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)
}

/** Normalize without requiring the final file to exist, so missing subscriptions can be removed. */
export async function repositorySource(
  source: string,
  repository: string,
  mustExist = true,
): Promise<string> {
  if (source.startsWith("https://")) return new URL(source).href
  if (/^[a-z]+:/i.test(source)) throw new Error("Use a local path or HTTPS URL")
  const path = resolve(repository, source)
  if (!within(repository, path))
    throw new Error("Repository catalogs must stay inside the checkout")
  let existing = path
  while (true) {
    try {
      const actual = await realpath(existing)
      if (!within(repository, actual))
        throw new Error(
          "Repository catalog symlinks must stay inside the checkout",
        )
      if (mustExist) return await realpath(path)
      // Preserve the lexical spelling for missing references; canonicalize existing files.
      try {
        return await realpath(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        return path
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        mustExist ||
        existing === repository
      )
        throw error
      // Do not walk past dangling symlinks: their eventual destination cannot be trusted.
      const stat = await lstat(existing).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
          return null
        },
      )
      if (stat?.isSymbolicLink())
        throw new Error(
          `Cannot resolve repository catalog symlink: ${existing}`,
        )
      existing = dirname(existing)
    }
  }
}

export async function readRepositoryManifest(
  repository: string,
): Promise<{ catalogs: string[] }> {
  return (await readRepositoryManifestSnapshot(repository)).manifest
}

export async function readRepositoryManifestSnapshot(
  repository: string,
): Promise<{
  manifest: { catalogs: string[] }
  raw: Buffer | null
}> {
  const path = join(repository, ".loadout/catalogs.json")
  await assertSafePath(path)
  const raw = await readOptionalBytes(path)
  const manifest =
    raw === null
      ? { catalogs: [] }
      : repositoryManifestSchema.parse(JSON.parse(raw.toString("utf8")))
  for (const source of manifest.catalogs) {
    if (
      !source.startsWith("https://") &&
      (isAbsolute(source) || source.includes("\\"))
    )
      throw new Error("Shared catalog paths must be relative to the repository")
  }
  return { manifest, raw }
}

export interface Subscription {
  source: string
  scope: "repository" | "global"
  repository?: string
  automatic?: boolean
  shared?: boolean
}
export interface CatalogListing {
  catalogs: Catalog[]
  errors: string[]
  subscriptions: Subscription[]
  failures: Map<string, string>
  repositoryError?: string
}

export async function loadSubscriptions(
  globalSources: string[],
  repository?: string,
): Promise<CatalogListing> {
  const subscriptions: Subscription[] = globalSources.map((source) => ({
    source,
    scope: "global",
  }))
  const errors: string[] = []
  let repositoryError: string | undefined
  if (repository) {
    const conventional = join(repository, ".loadout/catalog.json")
    try {
      await lstat(conventional)
      subscriptions.push({
        source: await repositorySource(conventional, repository, false),
        scope: "repository",
        repository,
        automatic: true,
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        errors.push(`${conventional}: ${message(error)}`)
    }
    try {
      const manifest = await readRepositoryManifest(repository)
      for (const reference of manifest.catalogs) {
        try {
          subscriptions.push({
            source: await repositorySource(reference, repository, false),
            scope: "repository",
            repository,
            shared: true,
          })
        } catch (error) {
          errors.push(`${reference}: ${message(error)}`)
        }
      }
    } catch (error) {
      repositoryError = `${join(repository, ".loadout/catalogs.json")}: ${message(error)}`
      errors.push(repositoryError)
    }
  }
  const catalogs: Catalog[] = []
  const failures = new Map<string, string>()
  try {
    catalogs.push({
      ...(await loadCatalog(builtin, true, {
        source: builtin,
        scope: "global",
        catalogId: "loadout",
      })),
      subscriptionScope: "global",
      automatic: true,
    })
  } catch (error) {
    failures.set(builtin, message(error))
    errors.push(`${builtin}: ${message(error)}`)
  }
  for (const source of new Set(subscriptions.map((s) => s.source))) {
    const entries = subscriptions.filter((s) => s.source === source)
    const repo = entries.find((s) => s.scope === "repository")
    const global = entries.some((s) => s.scope === "global")
    const origin = repo ?? entries[0]!
    try {
      const catalog = await loadCatalog(source, false, {
        source,
        scope: origin.scope,
        repository: origin.repository,
      })
      if (catalogs.some((c) => c.id === catalog.id))
        throw new Error(
          `Conflicting catalog ID ${catalog.id} from different sources; refusing ${source}`,
        )
      catalogs.push({
        ...catalog,
        subscriptionScope: repo && global ? "both" : origin.scope,
        automatic: entries.some((s) => s.automatic),
        shared: entries.some((s) => s.shared),
      })
      errors.push(
        ...(catalog.issues ?? []).map((issue) => `${source}: ${issue}`),
      )
    } catch (error) {
      failures.set(source, message(error))
      errors.push(`${source}: ${message(error)}`)
    }
  }
  return { catalogs, errors, subscriptions, failures, repositoryError }
}
