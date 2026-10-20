import { realpath } from "node:fs/promises"
import { join } from "node:path"
import type { CatalogOrigin, LoadedKit, Scope } from "../domain/kit"
import {
  builtin,
  loadRepositoryListing,
  message,
  type CatalogListing,
} from "./catalogs"
import { snapshotNode, reconcile, type NodeSnapshot } from "./files"
import { assertLink } from "./outputs"
import type { State } from "./state"
import { canonical } from "../domain/content"
export { canonical } from "../domain/content"

export type KitDriftStatus =
  | "current"
  | "changed"
  | "kit-missing"
  | "kit-unavailable"
  | "catalog-unavailable"
  | "subscription-missing"
  | "untracked"
export interface KitDrift {
  key: string
  scope: Scope
  origin?: CatalogOrigin
  status: KitDriftStatus
  reason: string
  latest?: LoadedKit
}
export interface FileDrift {
  path: string
  status: "current" | "missing" | "modified" | "unreadable" | "unsafe"
  reason: string
}
export interface DriftReport {
  kits: KitDrift[]
  files: FileDrift[]
}

export async function sourceKit(
  item: LoadedKit,
  listing: CatalogListing,
  globalSources: string[],
  cache: Map<string, Promise<CatalogListing>>,
): Promise<{ status: KitDriftStatus; reason: string; latest?: LoadedKit }> {
  const origin = item.origin
  if (origin?.scope === "repository") {
    const repository = origin.repository!
    if (origin.source !== join(repository, ".loadout/kits"))
      return {
        status: "subscription-missing",
        reason: `Repository catalog indexes and subscriptions are no longer used. The saved snapshot remains available: ${origin.source}`,
      }
    let pending = cache.get(repository)
    if (!pending) {
      pending = (async () => {
        await realpath(repository)
        return loadRepositoryListing(repository)
      })()
      cache.set(repository, pending)
    }
    try {
      listing = await pending
    } catch (error) {
      return {
        status: "catalog-unavailable",
        reason: `Origin repository unavailable (${repository}): ${message(error)}`,
      }
    }
  }
  let catalog
  if (origin) {
    const subscribed =
      origin.source === builtin ||
      (origin.scope === "repository"
        ? listing.catalogs.some(
            (catalog) =>
              catalog.kind === "repo" && catalog.source === origin.source,
          )
        : globalSources.includes(origin.source))
    if (!subscribed)
      return {
        status: "subscription-missing",
        reason: `Original ${origin.scope} source is no longer present: ${origin.source}`,
      }
    const failure = listing.failures.get(origin.source)
    if (failure) return { status: "catalog-unavailable", reason: failure }
    catalog = listing.catalogs.find(
      (c) =>
        c.source === origin.source &&
        c.id === (origin.catalogId ?? item.key.split("/")[0]),
    )
    if (!catalog)
      return {
        status: "catalog-unavailable",
        reason: `Original catalog identity is unavailable: ${origin.source}`,
      }
  } else {
    catalog = listing.catalogs.find((c) => c.id === item.key.split("/")[0])
    if (!catalog)
      return {
        status: "untracked",
        reason: "Saved kit has no provenance and no matching current catalog",
      }
  }
  if (origin?.scope === "repository" && origin.file) {
    const unavailable = listing.repoInventory.get(origin.file)
    if (unavailable?.reason)
      return { status: "kit-unavailable", reason: unavailable.reason }
  }
  const latest = catalog.kits.find((kit) => kit.key === item.key)
  if (!latest) {
    const unavailable = catalog.unavailableKits?.find(
      (kit) => kit.key === item.key,
    )
    return unavailable
      ? { status: "kit-unavailable", reason: unavailable.reason }
      : {
          status: "kit-missing",
          reason: "Kit is no longer listed by its catalog",
        }
  }
  const current = origin
    ? {
        ...latest,
        origin: origin.scope === "repository" ? latest.origin : origin,
      }
    : latest
  return canonical(item.kit) === canonical(latest.kit)
    ? {
        status: "current",
        reason: "Saved definition matches its live source",
        latest: current,
      }
    : {
        status: "changed",
        reason:
          "Live definition differs from the saved snapshot; update explicitly",
        latest: current,
      }
}

export async function inspectDrift(
  state: State,
  repository: string,
  listing: CatalogListing,
): Promise<DriftReport> {
  const cache = new Map<string, Promise<CatalogListing>>([
    [repository, Promise.resolve(listing)],
  ])
  const effective = { ...state.repositories[repository], ...state.global }
  const kits: KitDrift[] = []
  for (const item of Object.values(effective)) {
    const repo = !!state.repositories[repository]?.[item.key]
    const global = !!state.global[item.key]
    kits.push({
      key: item.key,
      scope: repo && global ? "both" : global ? "global" : "repository",
      origin: item.origin,
      ...(await sourceKit(item, listing, state.catalogs, cache)),
    })
  }
  const files: FileDrift[] = []
  for (const [path, managed] of Object.entries(state.managed)) {
    let node: NodeSnapshot
    try {
      node = await snapshotNode(path, managed.type === "symlink")
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      files.push({
        path,
        status: code === "EACCES" || code === "EPERM" ? "unreadable" : "unsafe",
        reason: message(error),
      })
      continue
    }
    if (node.kind === "missing") {
      files.push({
        path,
        status: "missing",
        reason: "Managed output is missing",
      })
      continue
    }
    try {
      if (managed.type === "symlink") {
        assertLink(path, managed, state.managed)
        if (node.kind !== "symlink" || node.target !== managed.target)
          throw new Error("Managed link target was changed")
        const source = await snapshotNode(managed.source)
        if (source.kind !== "file")
          throw new Error("Managed link source is missing")
        const baseline = state.managed[managed.source]!
        reconcile(
          managed.source,
          source.content,
          baseline,
          structuredClone(baseline),
        )
      } else {
        if (node.kind !== "file")
          throw new Error("Managed output is not a regular file")
        reconcile(path, node.content, managed, structuredClone(managed))
      }
      files.push({
        path,
        status: "current",
        reason:
          managed.type === "symlink"
            ? "Managed link and its source match"
            : managed.type === "ignore"
              ? "Owned ignore section matches; unrelated rules are ignored"
              : "Managed content matches; unrelated instruction text is ignored",
      })
    } catch (error) {
      files.push({ path, status: "modified", reason: message(error) })
    }
  }
  return { kits, files }
}
