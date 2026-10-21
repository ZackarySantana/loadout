import type { Catalog } from "../domain/kit"
import { catalogStaleDays } from "../domain/catalog-freshness"

export function catalogCacheLabel(cache: Catalog["cache"]): string | undefined {
  const days = catalogStaleDays(cache)
  return days >= 1
    ? `stale by ${days} ${days === 1 ? "day" : "days"}`
    : undefined
}

export function catalogKitCountLabel(catalog: Catalog): string {
  const count = catalog.kits.length
  if (catalog.hydration === "deferred" && !count) return "kits not loaded"
  const partial =
    catalog.hydration === "partial" || catalog.hydration === "deferred"
  return `${count}${partial ? " available" : ""} ${count === 1 ? "kit" : "kits"}`
}
