import type { Catalog } from "../domain/kit"

type UnavailableKit = NonNullable<Catalog["unavailableKits"]>[number]

export function catalogUnavailableReason(
  catalog: Catalog,
  entry: UnavailableKit,
): string {
  if (catalog.kind !== "remote") return entry.reason
  const resource =
    /^Cannot adapt upstream resource (.+): expected UTF-8 text; [\s\S]+$/.exec(
      entry.reason,
    )?.[1]
  if (!resource) return entry.reason
  const name = resource.split("/").pop() || resource
  return `Could not read required text resource (${name}). Raw supporting assets are copied unchanged.`
}

/** Match the complete source/key/reason tuple, never a broad error substring. */
export function unavailableCatalogWarning(
  error: string,
  catalogs: readonly Catalog[],
): { catalog: Catalog; entry: UnavailableKit } | undefined {
  for (const catalog of catalogs) {
    if (catalog.kind !== "remote") continue
    const entry = catalog.unavailableKits?.find(
      (entry) =>
        entry.key &&
        error === `${catalog.source}: ${entry.key}: ${entry.reason}`,
    )
    if (entry) return { catalog, entry }
  }
  return undefined
}

export function catalogWarningText(
  error: string,
  catalogs: readonly Catalog[],
): string {
  const match = unavailableCatalogWarning(error, catalogs)
  return match
    ? `${match.catalog.name} · ${match.entry.name}: ${catalogUnavailableReason(match.catalog, match.entry)}`
    : error
}
