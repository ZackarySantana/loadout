import type { Catalog } from "../domain/kit"

export function catalogCacheLabel(cache: Catalog["cache"]): string | undefined {
  if (!cache) return undefined
  if (cache.status === "stale")
    return cache.reason ? "Cached · refresh unavailable" : "Cached · check due"
  return cache.status === "cached" ? "Cached" : "Source checked"
}
