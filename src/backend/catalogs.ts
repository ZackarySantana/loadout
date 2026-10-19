import { readFile, realpath } from "node:fs/promises"
import { dirname, resolve, relative, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import { parseDocument } from "yaml"
import { catalogSchema, kitSchema, type Catalog } from "../domain/kit"

// The bundled entry point lives one directory below the catalog assets.
declare const LOADOUT_BUNDLED: boolean
const builtin = fileURLToPath(
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
): Promise<Catalog> {
  const catalog = catalogSchema.parse(JSON.parse(await readSource(source)))
  if (!permanent && catalog.id === "loadout")
    throw new Error("The Loadout catalog ID is reserved")
  const kits = await Promise.all(
    catalog.kits.map(async (entry) => {
      const text = await readSource(await kitSource(source, entry.source))
      const doc = parseDocument(text, { uniqueKeys: true })
      if (doc.errors.length)
        throw new Error(doc.errors.map((e) => e.message).join("\n"))
      const kit = kitSchema.parse(doc.toJS({ maxAliasCount: 20 }))
      if (kit.id !== entry.id)
        throw new Error(`Kit ID mismatch: expected ${entry.id}, got ${kit.id}`)
      return { key: `${catalog.id}/${kit.id}`, kit }
    }),
  )
  return {
    id: catalog.id,
    name: catalog.name,
    description: catalog.description,
    kits,
    source,
    permanent,
  }
}

export async function loadCatalogs(
  sources: string[],
): Promise<{ catalogs: Catalog[]; errors: string[] }> {
  const catalogs = [await loadCatalog(builtin, true)]
  const errors: string[] = []
  for (const source of sources) {
    try {
      const catalog = await loadCatalog(source)
      if (catalogs.some((c) => c.id === catalog.id))
        throw new Error(`Duplicate catalog ID: ${catalog.id}`)
      catalogs.push(catalog)
    } catch (error) {
      errors.push(
        `${source}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return { catalogs, errors }
}
