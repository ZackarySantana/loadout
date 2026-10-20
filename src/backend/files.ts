import { lstat, open, readFile, readlink } from "node:fs/promises"
import { constants } from "node:fs"
import { dirname, parse, resolve } from "node:path"
import type { Managed } from "./state"
import { z } from "zod"

export const nodeSnapshotSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing") }).strict(),
  z
    .object({
      kind: z.literal("file"),
      content: z.string(),
      mode: z.number().int().min(0).max(0o7777),
    })
    .strict(),
  z.object({ kind: z.literal("symlink"), target: z.string().min(1) }).strict(),
])
export type NodeSnapshot = z.infer<typeof nodeSnapshotSchema>

export function sameNode(a: NodeSnapshot, b: NodeSnapshot): boolean {
  return a.kind === "missing"
    ? b.kind === "missing"
    : a.kind === "symlink"
      ? b.kind === "symlink" && a.target === b.target
      : b.kind === "file" && a.content === b.content && a.mode === b.mode
}

/** Parents are always real directories. A leaf link is only read, never followed. */
export async function snapshotNode(
  path: string,
  allowLink = false,
): Promise<NodeSnapshot> {
  await assertSafeDirectory(dirname(path))
  let stat
  try {
    stat = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "missing" }
    throw error
  }
  if (stat.isSymbolicLink()) {
    if (!allowLink) throw new Error(`Refusing unmanaged symlink: ${path}`)
    return { kind: "symlink", target: await readlink(path) }
  }
  if (!stat.isFile()) throw new Error(`Not a regular file: ${path}`)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev)
      throw new Error(`File changed while reading: ${path}`)
    const content = await handle.readFile("utf8")
    await assertSafePath(path)
    const current = await lstat(path)
    if (
      current.ino !== opened.ino ||
      current.dev !== opened.dev ||
      current.size !== opened.size ||
      current.mtimeMs !== opened.mtimeMs ||
      current.ctimeMs !== opened.ctimeMs
    )
      throw new Error(`File changed while reading: ${path}`)
    return { kind: "file", content, mode: opened.mode & 0o7777 }
  } finally {
    await handle.close()
  }
}

export async function readOptional(path: string): Promise<string | null> {
  return (await readOptionalBytes(path))?.toString("utf8") ?? null
}

export async function readOptionalBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

// Refuse symlinks in every existing path component, including files being deleted.
export async function assertSafePath(path: string): Promise<void> {
  return assertPath(path, false)
}

export async function assertSafeDirectory(path: string): Promise<void> {
  return assertPath(path, true)
}

async function assertPath(path: string, directory: boolean): Promise<void> {
  let current = resolve(path)
  while (current !== parse(current).root) {
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`)
      if (current === resolve(path) && !directory && !stat.isFile())
        throw new Error(`Not a regular file: ${current}`)
      if ((directory || current !== resolve(path)) && !stat.isDirectory())
        throw new Error(`Not a directory: ${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    current = dirname(current)
  }
}

function block(key: string, content: string): string {
  return `<!-- loadout:${key} -->\n${content.trimEnd()}\n<!-- /loadout:${key} -->`
}

export function reconcile(
  path: string,
  before: string | null,
  previous: Managed | undefined,
  desired: Managed | undefined,
): string | null {
  if (previous?.type === "symlink" || desired?.type === "symlink")
    throw new Error(`Links must be reconciled without following them: ${path}`)
  if (previous && desired && previous.type !== desired.type)
    throw new Error(`Output type conflict: ${path}`)
  if (previous?.type === "file" || desired?.type === "file") {
    if (previous?.type === "file" && before !== previous.content)
      throw new Error(
        `Managed file was edited or removed; restore it before applying: ${path}`,
      )
    if (!previous && before !== null)
      throw new Error(`Will not overwrite an unmanaged file: ${path}`)
    return desired?.type === "file" ? desired.content : null
  }
  let text = before ?? ""
  const oldInstructions =
    previous?.type === "instructions" ? previous : undefined
  const instructions = desired?.type === "instructions" ? desired : undefined
  const originallyAbsent = oldInstructions
    ? (oldInstructions.originallyAbsent ?? false)
    : before === null
  if (instructions) {
    instructions.originallyAbsent = originallyAbsent
    instructions.layout = {}
  }
  for (const [key, content] of Object.entries(
    previous?.type === "instructions" ? previous.blocks : {},
  )) {
    const old = block(key, content)
    const index = text.indexOf(old)
    if (index < 0 || text.indexOf(old, index + old.length) >= 0)
      throw new Error(
        `Managed instructions were edited or removed; restore the block before applying: ${path}`,
      )
    const next =
      desired?.type === "instructions" ? desired.blocks[key] : undefined
    const layout = oldInstructions?.layout?.[key]
    if (next !== undefined) {
      text =
        text.slice(0, index) + block(key, next) + text.slice(index + old.length)
      if (layout && instructions) instructions.layout![key] = layout
    } else {
      // Remove only separators we inserted, and only if they are still unchanged.
      const start =
        layout &&
        text.slice(Math.max(0, index - layout.prefix.length), index) ===
          layout.prefix
          ? index - layout.prefix.length
          : index
      const end = index + old.length
      const finish =
        layout && text.slice(end, end + layout.suffix.length) === layout.suffix
          ? end + layout.suffix.length
          : end
      text = text.slice(0, start) + text.slice(finish)
    }
  }
  for (const [key, content] of Object.entries(
    desired?.type === "instructions" ? desired.blocks : {},
  )) {
    if (previous?.type === "instructions" && key in previous.blocks) continue
    if (
      text.includes(`<!-- loadout:${key} -->`) ||
      text.includes(`<!-- /loadout:${key} -->`)
    )
      throw new Error(`Untracked Loadout block: ${path}`)
    const prefix = `${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}`
    instructions!.layout![key] = { prefix, suffix: "\n" }
    text += `${prefix}${block(key, content)}\n`
  }
  return text === "" && originallyAbsent ? null : text
}
