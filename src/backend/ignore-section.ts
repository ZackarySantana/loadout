import type { Managed } from "./state"

type Ignore = Extract<Managed, { type: "ignore" }>
const begin = "# >>> loadout managed ignores >>>"
const end = "# <<< loadout managed ignores <<<"

function block(patterns: string[], newline: string): string {
  return [begin, ...patterns, end].join(newline)
}

export function reconcileIgnore(
  path: string,
  before: string | null,
  previous?: Ignore,
  desired?: Ignore,
): string {
  let text = before ?? ""
  if (previous) {
    if (
      !previous.block ||
      previous.block !==
        block(
          previous.patterns,
          previous.block.includes("\r\n") ? "\r\n" : "\n",
        )
    )
      throw new Error(`Invalid managed ignore snapshot: ${path}`)
    const index = text.indexOf(previous.block)
    if (
      index < 0 ||
      text.indexOf(previous.block, index + 1) >= 0 ||
      text.split(begin).length !== 2 ||
      text.split(end).length !== 2
    )
      throw new Error(
        `Managed ignore section was edited or removed; restore it before applying: ${path}`,
      )
    if (desired) {
      desired.block = block(
        desired.patterns,
        previous.block.includes("\r\n") ? "\r\n" : "\n",
      )
      desired.layout = structuredClone(previous.layout)
      return (
        text.slice(0, index) +
        desired.block +
        text.slice(index + previous.block.length)
      )
    }
    const prefix = previous.layout?.prefix ?? ""
    const suffix = previous.layout?.suffix ?? ""
    const start =
      text.slice(Math.max(0, index - prefix.length), index) === prefix
        ? index - prefix.length
        : index
    const finish = index + previous.block.length
    const stop =
      text.slice(finish, finish + suffix.length) === suffix
        ? finish + suffix.length
        : finish
    const head = text.slice(0, start)
    const tail = text.slice(stop)
    // Retain a separator if later user rules now depend on our inserted newline.
    const separator =
      head && tail && !head.endsWith("\n") && !tail.startsWith("\n")
        ? previous.block.includes("\r\n")
          ? "\r\n"
          : "\n"
        : ""
    return head + separator + tail
  }
  if (!desired) return text
  if (text.includes(begin) || text.includes(end))
    throw new Error(`Untracked Loadout ignore section: ${path}`)
  const newline = text.includes("\r\n") ? "\r\n" : "\n"
  const prefix = text && !text.endsWith("\n") ? newline : ""
  desired.block = block(desired.patterns, newline)
  desired.layout = { prefix, suffix: newline }
  text += prefix + desired.block + newline
  return text
}
