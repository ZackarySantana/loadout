import { dirname, isAbsolute, resolve } from "node:path"
import type { State, Managed } from "./state"
import { reconcile, snapshotNode, type NodeSnapshot } from "./files"

/** Snapshot all dependencies, including real sources used to materialize old links. */
export async function planOutputs(
  previous: State["managed"],
  desired: State["managed"],
): Promise<{
  before: Map<string, NodeSnapshot>
  after: Map<string, NodeSnapshot>
}> {
  const before = new Map<string, NodeSnapshot>()
  for (const path of new Set([
    ...Object.keys(previous),
    ...Object.keys(desired),
  ])) {
    const managed = previous[path]
    const next = desired[path]
    if (
      managed &&
      next &&
      managed.type !== next.type &&
      (managed.type === "ignore" || next.type === "ignore")
    )
      throw new Error(
        `Output type conflicts with an owned ignore file: ${path}`,
      )
    const node = await snapshotNode(path, managed?.type === "symlink")
    if (managed?.type === "symlink") {
      if (node.kind !== "symlink" || node.target !== managed.target)
        throw new Error(
          `Managed link was changed or removed; restore it before applying: ${path}`,
        )
      assertLink(path, managed, previous)
    } else if (managed) {
      reconcile(
        path,
        node.kind === "file" ? node.content : null,
        managed,
        structuredClone(managed),
      )
    }
    before.set(path, node)
  }
  const after = new Map<string, NodeSnapshot>()
  for (const [path, node] of before) {
    const old = previous[path],
      next = desired[path]
    if (next?.type === "symlink") continue
    if (old?.type === "symlink") {
      if (!next) {
        after.set(path, { kind: "missing" })
        continue
      }
      const source = before.get(old.source)
      const baseline = previous[old.source]
      if (source?.kind !== "file" || !baseline || baseline.type === "symlink")
        throw new Error(
          `Managed link source is not a safe managed regular file: ${path}`,
        )
      const content = reconcile(path, source.content, baseline, next)
      after.set(
        path,
        content === null
          ? { kind: "missing" }
          : { kind: "file", content, mode: source.mode },
      )
    } else {
      const content = reconcile(
        path,
        node.kind === "file" ? node.content : null,
        old,
        next,
      )
      after.set(
        path,
        content === null
          ? { kind: "missing" }
          : {
              kind: "file",
              content,
              mode: node.kind === "file" ? node.mode : 0o600,
            },
      )
    }
  }
  // Resolve real files first so a former primary can prove its notes survive reordering.
  for (const [path, node] of before) {
    const old = previous[path],
      next = desired[path]
    if (next?.type !== "symlink") continue
    assertLink(path, next, desired)
    if (old?.type !== "symlink" && node.kind !== "missing") {
      if (!old)
        throw new Error(
          `Will not overwrite an unmanaged file with a link: ${path}`,
        )
      if (old.type === "instructions") {
        const remainder = reconcile(
          path,
          node.kind === "file" ? node.content : null,
          old,
          undefined,
        )
        const oldTarget = previous[next.source]
        const newTarget = desired[next.source]
        const materialized = after.get(next.source)
        const preservedCanonical =
          node.kind === "file" &&
          oldTarget?.type === "symlink" &&
          oldTarget.source === path &&
          newTarget?.type === "instructions" &&
          materialized?.kind === "file" &&
          materialized.content ===
            reconcile(
              next.source,
              node.content,
              old,
              structuredClone(newTarget),
            )
        if (
          (!old.originallyAbsent ||
            (remainder !== null && remainder.trim() !== "")) &&
          !preservedCanonical
        )
          throw new Error(
            `Cannot link instructions unless unrelated text is preserved at the new primary: ${path}. Choose copy mode or reconcile secondary notes manually.`,
          )
      }
    }
    after.set(path, { kind: "symlink", target: next.target })
  }
  return { before, after }
}

export function assertLink(
  path: string,
  link: Extract<Managed, { type: "symlink" }>,
  managed: State["managed"],
): void {
  if (
    isAbsolute(link.target) ||
    resolve(dirname(path), link.target) !== link.source ||
    !isAbsolute(link.source) ||
    !managed[link.source] ||
    !["file", "instructions"].includes(managed[link.source]!.type)
  )
    throw new Error(
      `Managed link must point directly to its managed regular source: ${path}`,
    )
}
