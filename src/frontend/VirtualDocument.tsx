import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  untrack,
  type JSX,
} from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import {
  DocumentHeights,
  estimateBlock,
  previewDocument,
  type DocumentBlock,
  type PreviewBlock,
} from "./preview-document"

export { shouldVirtualizeDocument } from "./preview-document"
export type { PreviewBlock } from "./preview-document"

export interface VirtualDocumentProps {
  content: string
  markdown: boolean
  viewport?: () => ScrollBoxRenderable | undefined
  render: (block: PreviewBlock) => JSX.Element
}

interface Position {
  top: number
  height: number
  width: number
  scrollTop: number
  rootY: number
  viewportY: number
}

interface BlockAnchor {
  key: string
  index: number
  inset: number
}

interface DocumentMember {
  root: () => BoxRenderable | undefined
  width: () => number
  total: () => number
  settled: () => boolean
  capture: (top: number) => BlockAnchor | undefined
  resolve: (anchor: BlockAnchor) => number | undefined
  schedule: (navigation: boolean) => void
}

interface ViewportState {
  scroll: ScrollBoxRenderable
  members: Set<DocumentMember>
  active?: { member: DocumentMember; block: BlockAnchor }
  bottom: boolean
  navigating: boolean
  applying: boolean
  dirty: boolean
  max: number
  top: number
  changed: () => void
}

const viewports = new WeakMap<ScrollBoxRenderable, ViewportState>()
const maximum = (scroll: ScrollBoxRenderable) =>
  Math.max(
    0,
    scroll.verticalScrollBar.scrollSize - scroll.verticalScrollBar.viewportSize,
  )

function joinViewport(
  scroll: ScrollBoxRenderable,
  member: DocumentMember,
): ViewportState {
  let state = viewports.get(scroll)
  if (!state) {
    const created: ViewportState = {
      scroll,
      members: new Set(),
      bottom: false,
      navigating: false,
      applying: false,
      dirty: true,
      max: maximum(scroll),
      top: scroll.scrollTop,
      changed: () => {
        if (scroll.isDestroyed) return
        const max = maximum(scroll)
        const top = scroll.scrollTop
        const clamped = max < created.max && created.top > max && top === max
        created.max = max
        created.top = top
        created.dirty = true
        if (!created.applying && !clamped) {
          // Genuine navigation replaces the saved anchor. A native range clamp
          // must retain it: its absolute target can remain valid below new max.
          created.active = undefined
          created.bottom = max > 0 && top === max
          created.navigating = true
        }
        for (const entry of created.members)
          entry.schedule(!created.applying && !clamped)
      },
    }
    state = created
    viewports.set(scroll, state)
    scroll.verticalScrollBar.on("change", state.changed)
  }
  state.members.add(member)
  state.dirty = true
  return state
}

function leaveViewport(
  state: ViewportState | undefined,
  member: DocumentMember,
): void {
  if (!state) return
  state.members.delete(member)
  if (state.active?.member === member) state.active = undefined
  state.dirty = true
  if (!state.members.size) {
    state.scroll.verticalScrollBar.off("change", state.changed)
    viewports.delete(state.scroll)
  } else for (const entry of state.members) entry.schedule(false)
}

function chooseAnchor(state: ViewportState): ViewportState["active"] {
  const scroll = state.scroll
  // At the global start, retaining the start beats following a body/header.
  if (!scroll.scrollTop) return undefined
  let chosen:
    { member: DocumentMember; top: number; distance: number } | undefined
  for (const member of state.members) {
    const root = member.root()
    if (!root || root.isDestroyed || !member.total()) continue
    const top = scroll.viewport.y - root.y
    if (top >= member.total() || top + scroll.viewport.height <= 0) continue
    // Prefer a body containing the viewport top; otherwise the nearest body
    // below it, whose negative inset preserves the visible header above it.
    const distance = top >= 0 ? 0 : -top
    if (!chosen || distance < chosen.distance)
      chosen = { member, top, distance }
  }
  if (!chosen) return undefined
  const block = chosen.member.capture(chosen.top)
  return block ? { member: chosen.member, block } : undefined
}

function syncViewport(state: ViewportState | undefined): void {
  if (!state || !state.dirty || state.applying || state.scroll.isDestroyed)
    return
  const scroll = state.scroll
  state.max = maximum(scroll)
  state.top = scroll.scrollTop
  // Wait for every virtual document's height and width to reach native layout.
  // In particular, an offscreen document above the active one may move its
  // origin even though the active document's own internal heights did not change.
  for (const member of state.members) {
    const root = member.root()
    if (
      !root ||
      root.isDestroyed ||
      root.width !== member.width() ||
      root.height !== member.total()
    )
      return
  }
  let target: number | undefined
  if (state.bottom) {
    state.active = undefined
    state.navigating = false
    target = state.max
  } else {
    if (state.navigating) {
      for (const member of state.members) if (!member.settled()) return
      // Accept the newly navigated position after that measurement wave, rather
      // than fighting wheel/drag movement with estimate corrections.
      state.active = chooseAnchor(state)
      state.navigating = false
    }
    state.active ??= chooseAnchor(state)
    const active = state.active
    if (active) {
      const root = active.member.root()!
      const local = active.member.resolve(active.block)
      if (local === undefined) state.active = undefined
      else {
        // Screen y already includes content translation. This logical origin
        // cancels scrollTop and captures shifts caused by other documents.
        const origin = scroll.scrollTop + root.y - scroll.viewport.y
        target = origin + local
      }
    }
  }
  state.dirty = false
  if (target === undefined) return
  target = Math.max(0, Math.min(state.max, target))
  if (target === scroll.scrollTop) return
  state.applying = true
  try {
    scroll.scrollTop = target
  } finally {
    state.applying = false
  }
}

/** Only the viewport and one viewport of overscan own native renderables. */
export function VirtualDocument(props: VirtualDocumentProps) {
  const renderer = useRenderer()
  const document = createMemo(() =>
    previewDocument(props.content, props.markdown),
  )
  let blocks = document()
  let indexes = new Map(blocks.map((block, index) => [block.key, index]))
  let width = 80
  let heights = new DocumentHeights(
    blocks.map((block) => estimateBlock(block, width)),
  )
  let root: BoxRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined
  let viewportState: ViewportState | undefined
  let disposed = false
  let dirty = true
  let queued = false
  let generation = 0
  let moving = false
  let synchronizing = false
  let position: Position | undefined
  const nodes = new Map<string, BoxRenderable>()
  // Two recent widths per block, owned only by the current document. Offscreen
  // buffers and native text measurement are never used to populate this cache.
  const measured = new Map<string, Map<number, number>>()
  const [window, setWindow] = createSignal({
    blocks: [] as DocumentBlock[],
    start: -1,
    end: -1,
    before: 0,
    after: 0,
    total: heights.offset(blocks.length),
  })

  const publish = (top: number, height: number) => {
    const total = heights.offset(blocks.length)
    const overscan = Math.max(8, height)
    const outside = top + height + overscan < 0 || top - overscan >= total
    const start = outside ? 0 : heights.indexAt(Math.max(0, top - overscan))
    const end =
      outside || !blocks.length
        ? start
        : Math.min(
            blocks.length,
            heights.indexAt(Math.max(0, top + height + overscan)) + 1,
          )
    const before = heights.offset(start)
    const after = total - heights.offset(end)
    const previous = untrack(window)
    if (
      previous.start === start &&
      previous.end === end &&
      previous.before === before &&
      previous.after === after &&
      previous.total === total &&
      previous.blocks.length === end - start &&
      previous.blocks.every((block, index) => block === blocks[start + index])
    )
      return
    setWindow({
      blocks: blocks.slice(start, end),
      start,
      end,
      before,
      after,
      total,
    })
  }
  const bindScroll = (next: ScrollBoxRenderable | undefined) => {
    if (next === scroll) return
    leaveViewport(viewportState, member)
    scroll = next?.isDestroyed ? undefined : next
    viewportState = scroll ? joinViewport(scroll, member) : undefined
    position = undefined
    dirty = true
  }
  const sync = () => {
    if (
      disposed ||
      !root ||
      root.isDestroyed ||
      renderer.isDestroyed ||
      synchronizing
    )
      return
    bindScroll(props.viewport?.())
    if (!root.width || !scroll || scroll.isDestroyed || !scroll.viewport.height)
      return
    const next: Position = {
      top: scroll.viewport.y - root.y,
      height: scroll.viewport.height,
      width: root.width,
      scrollTop: scroll.scrollTop,
      rootY: root.y,
      viewportY: scroll.viewport.y,
    }
    if (
      !dirty &&
      position &&
      next.top === position.top &&
      next.height === position.height &&
      next.width === position.width &&
      next.scrollTop === position.scrollTop &&
      next.rootY === position.rootY &&
      next.viewportY === position.viewportY
    ) {
      // A sibling can change the global range without moving this root.
      if (viewportState && maximum(scroll) !== viewportState.max)
        viewportState.dirty = true
      syncViewport(viewportState)
      return
    }
    synchronizing = true
    try {
      if (viewportState) viewportState.dirty = true
      if (width !== next.width) {
        width = next.width
        heights = new DocumentHeights(
          blocks.map(
            (block) =>
              measured.get(block.key)?.get(width) ??
              estimateBlock(block, width),
          ),
        )
      }
      position = next
      for (const block of untrack(window).blocks) {
        const node = nodes.get(block.key)
        if (
          !node ||
          node.isDestroyed ||
          node.width !== width ||
          node.height <= 0
        )
          continue
        let cache = measured.get(block.key)
        if (!cache) measured.set(block.key, (cache = new Map()))
        cache.set(width, node.height)
        if (cache.size > 2) cache.delete(cache.keys().next().value!)
      }
      // Only mounted blocks are inspected; prefix corrections are logarithmic.
      const current = untrack(window)
      for (let index = current.start; index < current.end; index++) {
        const block = blocks[index]
        if (!block || current.blocks[index - current.start] !== block) continue
        const height = measured.get(block.key)?.get(width)
        if (height !== undefined && height !== heights.values[index])
          heights.set(index, height)
      }
      dirty = false
      publish(next.top, next.height)
      const nextWindow = untrack(window)
      // A scroll-driven mount settles on a later native layout. Suppress
      // compensation for that whole measurement wave, not just its first frame.
      if (root.height === nextWindow.total && visibleMeasured()) moving = false
      syncViewport(viewportState)
    } finally {
      synchronizing = false
    }
  }
  const schedule = () => {
    dirty = true
    if (queued || disposed) return
    queued = true
    const scheduledGeneration = generation
    queueMicrotask(() => {
      if (disposed || scheduledGeneration !== generation) return
      queued = false
      untrack(sync)
    })
  }
  const visibleMeasured = () =>
    untrack(window).blocks.every((block) => {
      const node = nodes.get(block.key)
      return (
        node && !node.isDestroyed && node.width === width && node.height >= 0
      )
    })
  const member: DocumentMember = {
    root: () => root,
    width: () => width,
    total: () => heights.offset(blocks.length),
    settled: () => !moving && visibleMeasured(),
    capture: (top) => {
      if (!blocks.length) return undefined
      const index = heights.indexAt(Math.max(0, top))
      return {
        key: blocks[index]!.key,
        index,
        inset: top - heights.offset(index),
      }
    },
    resolve: (anchor) => {
      if (!blocks.length) return undefined
      const index =
        indexes.get(anchor.key) ?? Math.min(anchor.index, blocks.length - 1)
      anchor.key = blocks[index]!.key
      anchor.index = index
      // Negative insets intentionally retain the distance to a visible header.
      anchor.inset = Math.min(
        anchor.inset,
        Math.max(0, heights.values[index]! - 1),
      )
      return heights.offset(index) + anchor.inset
    },
    schedule: (navigation) => {
      if (navigation) moving = true
      schedule()
    },
  }

  createEffect(() => {
    const next = document()
    if (next === blocks) return
    untrack(() => {
      generation++
      queued = false
      if (viewportState) {
        viewportState.dirty = true
        if (viewportState.scroll.scrollTop === 0) {
          // App may reuse this component for a different kit while already at
          // zero, where scrollTo(0) emits no navigation event. Never carry an
          // old bottom/body affinity into replacement content at global start.
          viewportState.active = undefined
          viewportState.bottom = false
          viewportState.navigating = false
        }
      }
      const previous = new Map(blocks.map((block) => [block.key, block]))
      blocks = next.map((block) => previous.get(block.key) ?? block)
      indexes = new Map(blocks.map((block, index) => [block.key, index]))
      const keys = new Set(blocks.map((block) => block.key))
      for (const key of measured.keys())
        if (!keys.has(key)) measured.delete(key)
      heights = new DocumentHeights(
        blocks.map(
          (block) =>
            measured.get(block.key)?.get(width) ?? estimateBlock(block, width),
        ),
      )
      publish(position?.top ?? 0, position?.height ?? 24)
      schedule()
    })
  })

  const Row = (row: { block: DocumentBlock }) => {
    let node: BoxRenderable | undefined
    let alive = true
    onCleanup(() => {
      alive = false
      if (nodes.get(row.block.key) === node) nodes.delete(row.block.key)
    })
    return (
      <box
        ref={(value) => {
          node = value
          nodes.set(row.block.key, value)
        }}
        width="100%"
        minWidth={0}
        flexShrink={0}
        flexDirection="column"
        paddingTop={row.block.gap}
        onSizeChange={() => {
          if (alive) schedule()
        }}
      >
        {props.render(row.block)}
      </box>
    )
  }

  publish(0, 24)
  onMount(() => {
    // The frame listener merely compares a fixed viewport tuple on frames that
    // already happen. It neither requests frames nor runs an idle polling loop.
    renderer.on("frame", sync)
    schedule()
  })
  onCleanup(() => {
    disposed = true
    generation++
    renderer.off("frame", sync)
    leaveViewport(viewportState, member)
    viewportState = undefined
    nodes.clear()
    measured.clear()
  })

  return (
    <box
      ref={root}
      width="100%"
      minWidth={0}
      height={window().total}
      flexShrink={0}
      flexDirection="column"
      onSizeChange={schedule}
    >
      <box height={window().before} flexShrink={0} />
      <For each={window().blocks}>{(block) => <Row block={block} />}</For>
      <box height={window().after} flexShrink={0} />
    </box>
  )
}
