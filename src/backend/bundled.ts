import { fileURLToPath } from "node:url"

declare const LOADOUT_BUNDLED: boolean
const root = new URL(
  typeof LOADOUT_BUNDLED !== "undefined" && LOADOUT_BUNDLED
    ? "../catalog/"
    : "../../catalog/",
  import.meta.url,
)

/**
 * Catalogs shipped with Loadout are identified independently of the install
 * directory, which moves on every upgrade. Saved origins record these IDs.
 */
export const builtin = "bundled:loadout"
export function bundledRemoteSource(id: string): string {
  return `bundled:remote/${id}`
}

/** The file currently backing a bundled catalog identity. */
export function bundledPath(source: string): string | undefined {
  if (source === builtin) return fileURLToPath(new URL("catalog.json", root))
  const id = /^bundled:remote\/([a-z0-9-]+)$/.exec(source)?.[1]
  return id ? fileURLToPath(new URL(`remote/${id}.json`, root)) : undefined
}
