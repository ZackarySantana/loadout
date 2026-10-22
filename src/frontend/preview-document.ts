import { Lexer, type Token } from "marked"

export interface PreviewBlock {
  key: string
  content: string
  kind: "markdown" | "text" | "code"
}

export interface DocumentBlock extends PreviewBlock {
  gap: number
  lengths: number[]
}

const chunkCharacters = 4096
const chunkLines = 64
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function shouldVirtualizeDocument(content: string): boolean {
  if (content.length >= 20 * 1024) return true
  let lines = 1
  for (let i = 0; i < content.length; i++)
    if (content.charCodeAt(i) === 10 && ++lines >= 240) return true
  return false
}

function lengths(content: string): number[] {
  const result: number[] = []
  let start = 0
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) !== 10) continue
    result.push(i - start)
    start = i + 1
  }
  result.push(content.length - start)
  return result
}

// Keep each native text buffer bounded, even for a file with one enormous line.
// A newline at a chunk boundary is represented by the next vertical text box,
// not by an extra trailing empty row in the previous text buffer.
function textChunks(content: string): string[] {
  const chunks: string[] = []
  let segments: Intl.Segments | undefined
  let splitClusterUntil = 0
  let start = 0
  while (start < content.length) {
    let end = Math.min(content.length, start + chunkCharacters)
    let lines = 0
    let lastNewline = -1
    for (let i = start; i < end; i++) {
      if (content.charCodeAt(i) !== 10) continue
      lastNewline = i
      if (++lines === chunkLines) {
        end = i + 1
        break
      }
    }
    if (end < content.length && lines < chunkLines) {
      if (lastNewline >= start) end = lastNewline + 1
      else {
        // Look up only the cut boundary, without materializing every grapheme
        // or wrapped line. One segment view is reused for this text block.
        if (end > splitClusterUntil) {
          segments ??= graphemes.segment(content)
          const segment = segments.containing(end)
          if (segment && segment.index > start) end = segment.index
          else if (segment && segment.index === start)
            splitClusterUntil = segment.index + segment.segment.length
        }
        // A pathological cluster must not defeat the native buffer budget.
        // Preserve all codepoints, but split an oversized cluster across boxes.
        // Remember its end to avoid re-reading the huge segment on every cut.
        const previous = content.charCodeAt(end - 1)
        const next = content.charCodeAt(end)
        if (
          previous >= 0xd800 &&
          previous <= 0xdbff &&
          next >= 0xdc00 &&
          next <= 0xdfff
        )
          end--
      }
    }
    let chunk = content.slice(start, end)
    if (end < content.length && chunk.endsWith("\n")) chunk = chunk.slice(0, -1)
    chunks.push(chunk)
    start = end
  }
  return chunks
}

function children(token: Token): Token[] {
  if (token.type === "list") return token.items
  if (token.type === "table")
    return [...token.header, ...token.rows.flat()].flatMap(
      (cell) => cell.tokens,
    )
  return "tokens" in token ? (token.tokens ?? []) : []
}

// Native Markdown re-lexes each visible block. Resolve reference links using
// the full-document lexer's already resolved inline tokens, never by injecting
// definitions that might instead become code/HTML or visible definition nodes.
function localReferences(token: Token, budget = chunkCharacters): string {
  let raw = token.raw
  if (raw.length > budget) throw new Error("Reference expansion exceeds budget")
  if (
    (token.type === "link" || token.type === "image") &&
    token.href.length > budget
  )
    throw new Error("Reference destination exceeds budget")
  let cursor = 0
  for (const child of children(token)) {
    const index = raw.indexOf(child.raw, cursor)
    // Reserve the surrounding source before expanding this child. Each
    // replacement and intermediate parent string stays within the same budget.
    const available = budget - raw.length + child.raw.length
    const content = localReferences(child, Math.min(budget, available))
    if (index < 0) {
      if (content !== child.raw) throw new Error("Unlocatable reference link")
      continue
    }
    const end = index + child.raw.length
    if (content !== child.raw)
      raw = raw.slice(0, index) + content + raw.slice(end)
    cursor = index + content.length
  }
  if (token.type !== "link" && token.type !== "image") return raw
  if (!raw.startsWith("[") && !raw.startsWith("![")) return raw
  let depth = 0
  let close = -1
  for (let i = raw.startsWith("!") ? 1 : 0; i < raw.length; i++) {
    if (raw[i] === "\\") {
      i++
      continue
    }
    if (raw[i] === "[") depth++
    if (raw[i] === "]" && --depth === 0) {
      close = i
      break
    }
  }
  // Inline links, autolinks and bare GFM URLs already carry their context.
  if (close < 0 || raw[close + 1] === "(") return raw
  const available = budget - (close + 1) - 4
  // A definition elsewhere in the document can supply a multi-megabyte href
  // for a tiny reference. Reject it before scanning, encoding, or copying it.
  if (token.href.length > available)
    throw new Error("Reference destination exceeds budget")
  const parts: string[] = []
  let size = 0
  for (const character of token.href) {
    // Encode only one codepoint at a time; even a rejected escaped destination
    // cannot create an oversized intermediate string or parts array.
    const part = /[\s<>\\]/.test(character)
      ? encodeURIComponent(character)
      : character
    size += part.length
    if (size > available)
      throw new Error("Reference destination exceeds budget")
    parts.push(part)
  }
  return `${raw.slice(0, close + 1)}(<${parts.join("")}>)`
}

export function previewDocument(
  content: string,
  markdown: boolean,
): DocumentBlock[] {
  const result: DocumentBlock[] = []
  const occurrences = new Map<string, number>()
  const add = (text: string, kind: PreviewBlock["kind"], gap: number) => {
    // The content itself is the cache identity: no collision-prone hashes and
    // no retained bodies from previously closed documents.
    const identity = `${kind}:${gap}:${text}`
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    result.push({
      key: `${occurrence}:${identity}`,
      content: text,
      kind,
      gap,
      lengths: lengths(text),
    })
  }
  const plain = (text: string, kind: "text" | "code", gap = 0) => {
    if (!text) add("", kind, gap)
    for (const chunk of textChunks(text)) {
      add(chunk, kind, gap)
      gap = 0
    }
  }
  if (!markdown) {
    plain(content, "text")
    return result
  }
  let tokens: Token[]
  try {
    tokens = Lexer.lex(content, { gfm: true })
  } catch {
    plain(content, "text")
    return result
  }
  let previous: Token | undefined
  let whitespace = ""
  const separated = (token: Token) =>
    ["heading", "list", "code", "table", "blockquote", "hr"].includes(
      token.type,
    )
  for (const token of tokens) {
    if (token.type === "space") {
      whitespace += token.raw
      continue
    }
    if (token.type === "def") continue
    const gap =
      previous &&
      (separated(previous) ||
        separated(token) ||
        /\n[ \t]*\n/.test(previous.raw + whitespace))
        ? 1
        : 0
    if (token.type === "code") plain(token.text, "code", gap)
    else if (
      token.raw.length > chunkCharacters ||
      lengths(token.raw).length > chunkLines
    )
      plain(token.raw.replace(/\n$/, ""), "text", gap)
    else {
      try {
        const local = localReferences(token).replace(/\n+$/, "")
        if (local.length > chunkCharacters)
          plain(token.raw.replace(/\n$/, ""), "text", gap)
        else add(local, "markdown", gap)
      } catch {
        plain(token.raw.replace(/\n$/, ""), "text", gap)
      }
    }
    previous = token
    whitespace = ""
  }
  return result
}

export function estimateBlock(block: DocumentBlock, width: number): number {
  return (
    block.gap +
    block.lengths.reduce(
      (total, length) =>
        total + Math.max(1, Math.ceil(length / Math.max(1, width))),
      0,
    )
  )
}

/** Prefix sums with O(log n) measured-height updates and viewport lookup. */
export class DocumentHeights {
  private tree: number[]
  readonly values: number[]

  constructor(values: number[]) {
    this.values = values.slice()
    this.tree = new Array(values.length + 1).fill(0)
    for (let i = 0; i < values.length; i++) {
      const index = i + 1
      this.tree[index] = this.tree[index]! + values[i]!
      const parent = index + (index & -index)
      if (parent < this.tree.length)
        this.tree[parent] = this.tree[parent]! + this.tree[index]!
    }
  }

  offset(index: number): number {
    let sum = 0
    for (let i = index; i > 0; i -= i & -i) sum += this.tree[i]!
    return sum
  }

  set(index: number, height: number): void {
    const delta = height - this.values[index]!
    this.values[index] = height
    for (let i = index + 1; i < this.tree.length; i += i & -i)
      this.tree[i] = this.tree[i]! + delta
  }

  indexAt(offset: number): number {
    let index = 0
    let sum = 0
    let bit = 1
    while (bit * 2 < this.tree.length) bit *= 2
    for (; bit > 0; bit >>= 1) {
      const next = index + bit
      if (next < this.tree.length && sum + this.tree[next]! <= offset) {
        index = next
        sum += this.tree[next]!
      }
    }
    return Math.min(index, Math.max(0, this.values.length - 1))
  }
}
