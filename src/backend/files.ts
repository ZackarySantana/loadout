import { lstat, readFile } from "node:fs/promises"
import { dirname, parse, resolve } from "node:path"
import type { Managed } from "./state"

export async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

// Refuse symlinks in every existing path component, including files being deleted.
export async function assertSafePath(path: string): Promise<void> {
  let current = resolve(path)
  while (current !== parse(current).root) {
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`)
      if (current !== resolve(path) && !stat.isDirectory())
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
