import { createHash } from "node:crypto"
import { canonical } from "./content"
import type { CatalogOrigin, LoadedKit } from "./kit"

/** Content identity is independent of retrieval time and upstream commit hints. */
export function contentIdentity(item: LoadedKit): string {
  return (
    item.origin?.contentHash ??
    createHash("sha256").update(canonical(item.kit)).digest("hex")
  )
}

export function stableOrigin(origin: CatalogOrigin | undefined): unknown {
  if (!origin) return undefined
  const { remote, ...rest } = origin
  if (!remote) return rest
  const {
    commit: _commit,
    upstreamCommitDate: _date,
    retrievedAt: _retrieved,
    ...source
  } = remote
  return { ...rest, remote: source }
}

export function sameSourceContent(a: LoadedKit, b: LoadedKit): boolean {
  return (
    a.key === b.key &&
    canonical(a.kit) === canonical(b.kit) &&
    canonical(stableOrigin(a.origin)) === canonical(stableOrigin(b.origin))
  )
}

/** Normalize only recognized provenance containers, never authored kit/answer payloads. */
export function stableReviewData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableReviewData)
  if (value === null || typeof value !== "object") return value
  const object = value as Record<string, unknown>
  const kitContainer =
    typeof object.key === "string" &&
    object.kit !== null &&
    typeof object.kit === "object" &&
    Array.isArray((object.kit as Record<string, unknown>).outputs)
  const provenanceContainer =
    typeof object.key === "string" &&
    (kitContainer || typeof object.scope === "string")
  return Object.fromEntries(
    Object.entries(object).flatMap(([key, entry]) => {
      if (kitContainer && key === "installedAt") return []
      if (provenanceContainer && key === "origin")
        return [[key, stableOrigin(entry as CatalogOrigin | undefined)]]
      if (key === "kit" || key === "answers") return [[key, entry]]
      return [[key, stableReviewData(entry)]]
    }),
  )
}
