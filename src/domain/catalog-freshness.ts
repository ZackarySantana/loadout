import type { Catalog } from "./kit"

/** Browse inventory freshness only; source validation always checks upstream. */
export const catalogFreshnessMs = 86_400_000

/** Whole elapsed days since the last check, independent of transport/cache status. */
export function catalogStaleDays(
  cache: Catalog["cache"],
  now = Date.now(),
): number {
  if (!cache) return 0
  const checkedAt = Date.parse(cache.checkedAt)
  if (!Number.isFinite(checkedAt) || !Number.isFinite(now)) return 0
  return Math.max(0, Math.floor((now - checkedAt) / catalogFreshnessMs))
}
