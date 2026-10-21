import type { Catalog } from "../domain/kit"
import { catalogStaleDays } from "../domain/catalog-freshness"

export function catalogCacheLabel(cache: Catalog["cache"]): string | undefined {
  const days = catalogStaleDays(cache)
  return days >= 1
    ? `stale by ${days} ${days === 1 ? "day" : "days"}`
    : undefined
}
