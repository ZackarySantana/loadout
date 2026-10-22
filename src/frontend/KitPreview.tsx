import {
  createEffect,
  createMemo,
  createSignal,
  Index,
  onCleanup,
  Show,
} from "solid-js"
import { useRenderer } from "@opentui/solid"
import {
  SyntaxStyle,
  StyledText,
  TextAttributes,
  TextRenderable,
  BoxRenderable,
  type MarkdownRenderable,
  type Renderable,
  type MarkdownOptions,
  type StyleDefinitionInput,
  type TextChunk,
  type KeyEvent,
  type ScrollBoxRenderable,
} from "@opentui/core"
import {
  activeAnswers,
  defaults,
  matches,
  type Answers,
  type LoadedKit,
  type Scope,
} from "../domain/kit"
import { theme as color, harnessColors } from "./theme"
import { displayKitKey } from "../domain/catalog"
import type { AgentHarness } from "../domain/subagents"
import { resourceSize, type Resource } from "../domain/resource"
import {
  VirtualDocument,
  shouldVirtualizeDocument,
  type PreviewBlock,
} from "./VirtualDocument"

const harnessLabels: Record<AgentHarness, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
}

const codexCapabilityLabels: Record<string, string> = {
  shell_tool: "Shell",
  apps: "Apps",
  plugins: "Plugins",
  memories: "Memories",
  request_permissions_tool: "Permission requests",
}

// Preserve line breaks and tabs, but never pass terminal controls through.
const safeText = (text: string) =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")

function skillFrontmatter(content: string): {
  metadata?: string
  body: string
} {
  const opening = /^\uFEFF?---[ \t]*\r?\n/.exec(content)
  if (!opening) return { body: content }
  const rest = content.slice(opening[0].length)
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest)
  // An incomplete header is still content: never silently discard its text.
  if (!closing) return { body: content }
  return {
    metadata: rest.slice(0, closing.index),
    body: rest
      .slice(closing.index + closing[0].length)
      .replace(/^(?:[ \t]*\r?\n)+/, ""),
  }
}

function styles(excluded: boolean): Record<string, StyleDefinitionInput> {
  const body = excluded ? color.excluded : color.text
  const accent = excluded ? color.excluded : color.sage
  return {
    default: { fg: body },
    conceal: { fg: excluded ? color.excluded : color.border },
    "markup.heading": { fg: accent, bold: false },
    "markup.heading.1": { fg: accent, bold: false },
    "markup.heading.2": { fg: accent, bold: false },
    "markup.heading.3": { fg: accent, bold: false },
    "markup.heading.4": { fg: accent, bold: false },
    "markup.heading.5": { fg: accent, bold: false },
    "markup.heading.6": { fg: accent, bold: false },
    "markup.strong": { fg: accent, bold: true },
    "markup.italic": { fg: body, italic: true },
    "markup.strikethrough": { fg: body },
    "markup.link": { fg: accent, underline: true },
    "markup.link.label": { fg: accent, underline: true },
    "markup.link.url": { fg: accent, underline: true },
    "markup.raw": { fg: accent },
    "markup.quote": { fg: body },
    "markup.list": { fg: accent },
  }
}

export interface KitPreviewProps {
  item: LoadedKit
  answers?: Answers
  scope: Scope
  viewport?: () => ScrollBoxRenderable | undefined
  onControls?: (controls: KitPreviewControls | undefined) => void
}
export interface KitPreviewControls {
  handleKey: (key: KeyEvent) => boolean
  blur: () => void
}
interface Contribution {
  label: string
  accent: string
  included: boolean
  metadata?: AgentMetadata[]
  files: {
    path: string
    content: Resource
    markdown: boolean
    included: boolean
  }[]
  nested: boolean
  instructions: boolean
}

interface AgentMetadata {
  label: string
  harness?: AgentHarness
  values: { text: string; harness?: AgentHarness }[]
}

interface HeadingToken {
  type: string
  text?: string
  raw?: string
  href?: string
  tokens?: HeadingToken[]
}

/** Only heading inline tokens need a presentation override; body Markdown stays native. */
function headingText(
  heading: { depth: number; text: string; tokens?: HeadingToken[] },
  style: SyntaxStyle,
): StyledText {
  const fg = style.getStyle("markup.heading")?.fg
  const chunks: TextChunk[] = [
    {
      __isChunk: true,
      text: `${"#".repeat(heading.depth)} `,
      fg,
      attributes: 0,
    },
  ]
  const inline = (
    tokens: HeadingToken[],
    attributes = 0,
    link?: TextChunk["link"],
  ) => {
    for (const token of tokens) {
      let flags = attributes
      if (token.type === "strong") flags |= TextAttributes.BOLD
      if (token.type === "em") flags |= TextAttributes.ITALIC
      if (token.type === "del") flags |= TextAttributes.STRIKETHROUGH
      if (token.type === "link") flags |= TextAttributes.UNDERLINE
      const target =
        token.type === "link" && token.href
          ? { url: safeText(token.href) }
          : link
      if (token.tokens) inline(token.tokens, flags, target)
      else
        chunks.push({
          __isChunk: true,
          text: safeText(
            token.type === "br" ? "\n" : (token.text ?? token.raw ?? ""),
          ),
          fg,
          attributes: flags,
          link: target,
        })
    }
  }
  inline(heading.tokens ?? [{ type: "text", text: heading.text }])
  return new StyledText(chunks)
}

/** Content only: mount inside the parent's vertically scrolling details panel. */
export function KitPreview(props: KitPreviewProps) {
  const renderer = useRenderer()
  const includedStyle = SyntaxStyle.fromStyles(
    styles(false),
    renderer.nativeScene,
  )
  const excludedStyle = SyntaxStyle.fromStyles(
    styles(true),
    renderer.nativeScene,
  )
  onCleanup(() => {
    includedStyle.destroy()
    excludedStyle.destroy()
  })

  const answers = createMemo(() =>
    activeAnswers(props.item.kit, {
      ...defaults(props.item.kit),
      ...props.answers,
    }),
  )
  const interpolate = (content: string) =>
    safeText(
      content.replace(
        /\{\{\s*([a-z0-9-]+)\s*\}\}/g,
        (placeholder, key: string) => {
          const answer = answers()[key]
          const question = props.item.kit.questions.find(
            (entry) => entry.id === key,
          )
          if (
            answer === undefined ||
            (question?.type === "input" &&
              question.required &&
              String(answer).trim() === "")
          )
            return placeholder
          return Array.isArray(answer) ? answer.join(", ") : String(answer)
        },
      ),
    )

  // Markdown itself uses the package's bundled grammars. Code is informational,
  // not executable, and deliberately has no language parser (or grammar fetch).
  const codeNodes = new WeakSet<TextRenderable>()
  const headingNodes = new WeakMap<
    TextRenderable,
    { style: SyntaxStyle; render: (style: SyntaxStyle) => StyledText }
  >()
  const renderNode: NonNullable<MarkdownOptions["renderNode"]> = (
    token,
    context,
  ) => {
    if (token.type === "list") {
      const list = context.defaultRender()
      if (!list) return undefined
      // Native list reconciliation skips unchanged rows even on style refresh,
      // leaving their old inline colors behind. A custom wrapper opts just this
      // block out of that reuse. Native streaming still paints every row at once;
      // unchanged list text/style, documents, and other blocks stay untouched.
      const block = new BoxRenderable(renderer, {
        width: "100%",
        minWidth: 0,
        flexDirection: "column",
        flexShrink: 0,
      })
      block.add(list)
      return block
    }
    if (token.type === "heading") {
      // Paint one complete heading snapshot synchronously. Turning off conceal
      // for the document would also reveal emphasis/link syntax in its body.
      const render = (style: SyntaxStyle) =>
        headingText(
          { depth: token.depth, text: token.text, tokens: token.tokens },
          style,
        )
      const heading = new TextRenderable(renderer, {
        content: render(context.syntaxStyle),
        fg: context.syntaxStyle.getStyle("markup.heading")?.fg,
        width: "100%",
        minWidth: 0,
        flexShrink: 0,
        wrapMode: "word",
      })
      headingNodes.set(heading, { style: context.syntaxStyle, render })
      return heading
    }
    if (token.type !== "code") return undefined
    const code = new TextRenderable(renderer, {
      content: safeText(token.text),
      fg: context.syntaxStyle.getStyle("markup.raw")?.fg,
      width: "100%",
      minWidth: 0,
      flexShrink: 0,
      wrapMode: "word",
    })
    codeNodes.add(code)
    return code
  }

  const DocumentFragment = (fragmentProps: {
    content: string
    kind: PreviewBlock["kind"]
    included: boolean
    muted?: boolean
  }) => {
    const syntaxStyle = createMemo(() =>
      fragmentProps.included ? includedStyle : excludedStyle,
    )
    // Each visible fragment owns its native document and style refresh. A shared
    // ref would recolor only the final fragment of a windowed document.
    let markdown: MarkdownRenderable | undefined
    createEffect(() => {
      const style = syntaxStyle()
      fragmentProps.content
      // Native style updates omit the custom code nodes and rule borders.
      // Refresh those properties without replacing their document or blocks.
      const recolor = (node: Renderable) => {
        if (node instanceof TextRenderable && codeNodes.has(node))
          node.fg = style.getStyle("markup.raw")!.fg!
        if (node instanceof TextRenderable) {
          const heading = headingNodes.get(node)
          if (heading && heading.style !== style) {
            node.fg = style.getStyle("markup.heading")?.fg
            node.content = heading.render(style)
            heading.style = style
          }
        }
        if (
          node instanceof BoxRenderable &&
          Array.isArray(node.border) &&
          node.border.length === 1 &&
          node.border[0] === "top"
        )
          node.borderColor = style.getStyle("conceal")!.fg!
        node.getChildren().forEach(recolor)
      }
      if (markdown && !markdown.isDestroyed) recolor(markdown)
    })
    return (
      <Show
        when={fragmentProps.kind === "markdown"}
        fallback={
          <text
            width="100%"
            minWidth={0}
            flexShrink={0}
            wrapMode="word"
            fg={
              !fragmentProps.included
                ? color.excluded
                : fragmentProps.kind === "code"
                  ? color.sage
                  : fragmentProps.muted
                    ? color.muted
                    : color.text
            }
          >
            {fragmentProps.content}
          </text>
        }
      >
        {/* Top-level streaming supplies complete styled text immediately. */}
        <markdown
          ref={markdown}
          width="100%"
          minWidth={0}
          flexShrink={0}
          syntaxStyle={syntaxStyle()}
          fg={syntaxStyle().getStyle("default")?.fg}
          streaming
          internalBlockMode="top-level"
          conceal
          renderNode={renderNode}
          tableOptions={{
            wrapMode: "word",
            widthMode: "full",
            cellPaddingX: 0,
          }}
          content={fragmentProps.content}
        />
      </Show>
    )
  }

  const Content = (contentProps: {
    content: string
    markdown: boolean
    included: boolean
    skill?: boolean
  }) => {
    // Split the template, not interpolated answers, so typing cannot introduce
    // a delimiter that unexpectedly restructures the preview.
    const parts = createMemo(() =>
      contentProps.skill
        ? skillFrontmatter(contentProps.content)
        : { body: contentProps.content, metadata: undefined },
    )
    const metadata = createMemo(() => {
      const text = parts().metadata
      return text === undefined ? undefined : interpolate(text).trimEnd()
    })
    // Normalize only the displayed preview, never the kit payload.
    const content = createMemo(() => interpolate(parts().body).trimEnd())
    return (
      <>
        <Show when={metadata()}>
          <box
            width="100%"
            minWidth={0}
            flexShrink={0}
            flexDirection="column"
            marginBottom={content() ? 1 : 0}
          >
            <Show
              when={shouldVirtualizeDocument(metadata()!)}
              fallback={
                <text
                  width="100%"
                  minWidth={0}
                  flexShrink={0}
                  wrapMode="word"
                  fg={contentProps.included ? color.muted : color.excluded}
                >
                  {metadata()}
                </text>
              }
            >
              <VirtualDocument
                content={metadata()!}
                markdown={false}
                viewport={props.viewport}
                render={(block) => (
                  <DocumentFragment
                    content={block.content}
                    kind="text"
                    included={contentProps.included}
                    muted
                  />
                )}
              />
            </Show>
          </box>
        </Show>
        <Show
          when={shouldVirtualizeDocument(content())}
          fallback={
            <DocumentFragment
              content={content()}
              kind={contentProps.markdown ? "markdown" : "text"}
              included={contentProps.included}
            />
          }
        >
          <VirtualDocument
            content={content()}
            markdown={contentProps.markdown}
            viewport={props.viewport}
            render={(block) => (
              <DocumentFragment
                content={block.content}
                kind={block.kind}
                included={contentProps.included}
              />
            )}
          />
        </Show>
      </>
    )
  }

  const contributions = createMemo(() => {
    const sections: Contribution[] = []
    let instructions: Contribution | undefined
    for (const output of props.item.kit.outputs) {
      const included = matches(output.when, answers())
      if (output.type === "instructions") {
        if (!instructions) {
          instructions = {
            label: "Instructions",
            accent: color.instructions,
            included: false,
            files: [],
            nested: false,
            instructions: true,
          }
          sections.push(instructions)
        }
        instructions.included ||= included
        instructions.files.push({
          path: "",
          content: output.content,
          markdown: true,
          included,
        })
      } else if (output.type === "skill") {
        sections.push({
          label: `Skill · ${output.name}`,
          accent: color.skill,
          included,
          files: Object.entries(output.files)
            .sort(
              ([a], [b]) => Number(b === "SKILL.md") - Number(a === "SKILL.md"),
            )
            .map(([path, content]) => ({
              path,
              content,
              markdown: /\.(?:md|markdown|mdown|mkd)$/i.test(path),
              included,
            })),
          nested: true,
          instructions: false,
        })
      } else if (output.type === "agent") {
        const metadata: AgentMetadata[] = [
          {
            label: "Harnesses",
            values: output.harnesses.map((harness) => ({
              text: harnessLabels[harness],
              harness,
            })),
          },
        ]
        for (const harness of output.harnesses) {
          const options = output.options?.[harness]
          if (options?.model)
            metadata.push({
              label: `${harnessLabels[harness]} model`,
              harness,
              values: [{ text: options.model, harness }],
            })
          if (harness === "codex" && output.options?.codex?.features)
            metadata.push({
              label: "Codex disabled capabilities",
              harness,
              values: [
                {
                  text: Object.entries(output.options.codex.features)
                    .filter(([, value]) => value === false)
                    .map(([name]) => codexCapabilityLabels[name] ?? name)
                    .join(" · "),
                },
              ],
            })
          if (harness === "claude" && output.options?.claude?.tools)
            metadata.push({
              label: "Claude Code tools",
              harness,
              values: [{ text: output.options.claude.tools.join(" · ") }],
            })
          if (harness === "opencode")
            for (const [index, rule] of (
              output.options?.opencode?.permissions ?? []
            ).entries())
              metadata.push({
                label: `OpenCode permission ${index + 1}`,
                harness,
                values: [
                  {
                    text: `${rule.effect[0]!.toUpperCase()}${rule.effect.slice(1)} ${rule.action} on ${rule.resource}`,
                  },
                ],
              })
        }
        sections.push({
          label: `Agent · ${output.name}`,
          accent: color.skill,
          included,
          metadata,
          files: [
            {
              path: "",
              content: output.description,
              markdown: false,
              included,
            },
            {
              path: "",
              content: output.instructions,
              markdown: true,
              included,
            },
          ],
          nested: false,
          instructions: false,
        })
      } else {
        sections.push({
          label: `File · ${output.path}`,
          accent: color.file,
          included,
          files: [
            {
              path: output.path,
              content: output.content,
              markdown: /\.(?:md|markdown|mdown|mkd)$/i.test(output.path),
              included,
            },
          ],
          nested: false,
          instructions: false,
        })
      }
    }
    return sections
  })

  const fileId = (card: number, path: string) => `${card}:${path}`
  // Browser navigation inspects paths and resource types only. Unopened bodies
  // never reach Content's interpolation, sanitization, or Markdown parser.
  const supporting = createMemo(() =>
    contributions().flatMap((card, cardIndex) =>
      card.nested
        ? card.files
            .filter((file) => file.path !== "SKILL.md")
            .map((file) => ({
              id: fileId(cardIndex, file.path),
              path: file.path,
              label: card.label,
              included: file.included,
              raw: typeof file.content !== "string",
            }))
        : [],
    ),
  )
  const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set())
  const [browserOpen, setBrowserOpen] = createSignal(false)
  const [fileCursor, setFileCursor] = createSignal(0)
  let disposed = false
  let revealGeneration = 0
  let pendingReveal: (() => void) | undefined
  const cancelReveal = () => {
    revealGeneration++
    if (pendingReveal) renderer.off("frame", pendingReveal)
    pendingReveal = undefined
  }
  onCleanup(() => {
    disposed = true
    cancelReveal()
  })
  let previousKey = props.item.key
  let previousDefinition = props.item.kit
  createEffect(() => {
    const item = props.item
    if (item.key === previousKey && item.kit === previousDefinition) return
    previousKey = item.key
    previousDefinition = item.kit
    cancelReveal()
    setOpened(new Set<string>())
    setBrowserOpen(false)
    setFileCursor(0)
  })
  let browser: BoxRenderable | undefined
  const fileHeaderId = (id: string) =>
    `kit-preview:${encodeURIComponent(props.item.key)}:file:${encodeURIComponent(id)}:header`
  const queueReveal = (
    target: () => Renderable | undefined,
    visible: () => boolean,
    alignTop = false,
  ) => {
    cancelReveal()
    const generation = revealGeneration
    const item = props.item
    const key = item.key
    const definition = item.kit
    const current = () =>
      !disposed &&
      generation === revealGeneration &&
      props.item === item &&
      props.item.key === key &&
      props.item.kit === definition &&
      visible()
    queueMicrotask(() => {
      if (!current()) return
      const node = target()
      if (!node || node.isDestroyed) return
      // Solid mounts synchronously, but the new header's native coordinates
      // become available only after layout. Keep this a one-shot frame hook.
      const reveal = () => {
        renderer.off("frame", reveal)
        if (pendingReveal === reveal) pendingReveal = undefined
        if (!current() || node.isDestroyed || target() !== node) return
        const viewport = props.viewport?.()
        if (!viewport || viewport.isDestroyed) return
        if (alignTop)
          viewport.scrollTo(viewport.scrollTop + node.y - viewport.viewport.y)
        else viewport.scrollChildIntoView(node.id)
      }
      pendingReveal = reveal
      renderer.once("frame", reveal)
      renderer.requestRender()
    })
  }
  const revealBrowser = () => {
    const target = browser
    queueReveal(() => target, browserOpen)
  }
  const closeBrowser = () => {
    setBrowserOpen(false)
    cancelReveal()
  }
  const toggleFile = (id: string) => {
    const closing = opened().has(id)
    setOpened((before) => {
      const next = new Set(before)
      if (closing) next.delete(id)
      else next.add(id)
      return next
    })
    if (closing) {
      cancelReveal()
      return
    }
    closeBrowser()
    const headerId = fileHeaderId(id)
    queueReveal(
      () => props.viewport?.()?.findDescendantById(headerId),
      () => opened().has(id) && !browserOpen(),
      true,
    )
  }
  const focusBrowser = () => {
    setBrowserOpen(true)
    revealBrowser()
  }
  const controls: KitPreviewControls = {
    blur: closeBrowser,
    handleKey(key) {
      const modified = key.ctrl || key.meta || key.shift
      if (!modified && key.name === "f" && supporting().length) {
        focusBrowser()
        return true
      }
      if (!browserOpen()) return false
      const vertical = key.name === "up" || key.name === "down"
      if (
        key.name === "pageup" ||
        key.name === "pagedown" ||
        (vertical && key.shift && !key.ctrl && !key.meta)
      )
        return false
      const space = key.name === "space" || key.sequence === " "
      // App also recognizes modified arrows, Enter, Space, and Escape. Never
      // let those activate a left-panel control while the picker owns focus.
      if (modified)
        return (
          vertical ||
          key.name === "left" ||
          key.name === "right" ||
          key.name === "h" ||
          key.name === "j" ||
          key.name === "k" ||
          key.name === "l" ||
          key.name === "return" ||
          key.name === "escape" ||
          space
        )
      if (key.name === "escape" || key.name === "left" || key.name === "h")
        closeBrowser()
      else if (key.name === "up" || key.name === "k") {
        setFileCursor((index) => Math.max(0, index - 1))
        revealBrowser()
      } else if (key.name === "down" || key.name === "j") {
        setFileCursor((index) => Math.min(supporting().length - 1, index + 1))
        revealBrowser()
      } else if (key.name === "return" || space) {
        const file = supporting()[fileCursor()]
        if (file) toggleFile(file.id)
      } else if (key.name === "right" || key.name === "l") {
        const file = supporting()[fileCursor()]
        if (file && !opened().has(file.id)) toggleFile(file.id)
      } else return false
      return true
    },
  }
  createEffect(() => {
    const register = props.onControls
    register?.(controls)
    onCleanup(() => register?.(undefined))
  })
  const fileWindow = createMemo(() => {
    const files = supporting()
    const start = Math.max(0, Math.min(fileCursor() - 2, files.length - 6))
    return files.slice(start, start + 6).map((file, index) => ({
      ...file,
      index: start + index,
    }))
  })

  return (
    <box
      width="100%"
      minWidth={0}
      flexDirection="column"
      flexShrink={0}
      gap={1}
    >
      <text
        width="100%"
        minWidth={0}
        fg={color.sage}
        wrapMode="word"
        flexShrink={0}
      >
        <b>{safeText(props.item.kit.name)}</b>
        <span
          style={{ fg: color.muted }}
        >{` * ${safeText(displayKitKey(props.item.key))}`}</span>
      </text>
      <Show when={props.item.kit.description}>
        <Content content={props.item.kit.description} markdown included />
      </Show>
      <Show when={supporting().length}>
        <box
          ref={browser}
          width="100%"
          minWidth={0}
          flexDirection="column"
          flexShrink={0}
        >
          <text
            width="100%"
            minWidth={0}
            wrapMode="word"
            flexShrink={0}
            fg={browserOpen() ? color.sage : color.muted}
            onMouseDown={(event) => {
              if (event.button !== 0) return
              event.stopPropagation()
              if (browserOpen()) closeBrowser()
              else focusBrowser()
            }}
          >
            {`${browserOpen() ? "▾" : "▸"} Supporting files (${supporting().length}) · f files`}
          </text>
          <Show when={browserOpen()}>
            <text fg={color.muted} wrapMode="word" flexShrink={0}>
              ↑↓/jk select · Enter/Space open-close · ←/h/Esc back · →/l open
            </text>
            <Index each={fileWindow()}>
              {(file) => (
                <text
                  width="100%"
                  minWidth={0}
                  height={1}
                  flexShrink={0}
                  wrapMode="none"
                  fg={file().included ? color.text : color.excluded}
                  bg={
                    file().index === fileCursor() ? color.selected : undefined
                  }
                  onMouseDown={(event) => {
                    if (event.button !== 0) return
                    event.stopPropagation()
                    setFileCursor(file().index)
                    toggleFile(file().id)
                  }}
                >
                  {`${file().index === fileCursor() ? "›" : " "} ${opened().has(file().id) ? "−" : "+"} ${safeText(file().path)}${file().raw ? " · raw asset" : ""}`}
                </text>
              )}
            </Index>
            <text fg={color.muted} wrapMode="word" flexShrink={0}>
              {`${fileCursor() + 1}/${supporting().length} · ${safeText(supporting()[fileCursor()]?.label ?? "")} · ${safeText(supporting()[fileCursor()]?.path ?? "")}`}
            </text>
          </Show>
        </box>
      </Show>
      {/* Native Markdown descendants can measure one cell wider than their
          container. Keep a gutter inside the details panel's content bounds. */}
      <Index each={contributions()}>
        {(card, cardIndex) => (
          <box
            width="100%"
            minWidth={0}
            flexDirection="column"
            flexShrink={0}
            border={["top"]}
            borderStyle="single"
            borderColor={card().included ? card().accent : color.excluded}
            title={safeText(card().label)}
            titleColor={card().included ? card().accent : color.excluded}
            titleAlignment="center"
            paddingX={1}
          >
            <Show when={!card().instructions && !card().included}>
              <text
                width="100%"
                minWidth={0}
                fg={color.excluded}
                wrapMode="word"
                flexShrink={0}
              >
                Not included
              </text>
            </Show>
            <Show when={card().metadata}>
              {(metadata) => (
                <box
                  width="100%"
                  minWidth={0}
                  flexDirection="column"
                  flexShrink={0}
                  marginBottom={1}
                >
                  <Index each={metadata()}>
                    {(field) => (
                      <text
                        width="100%"
                        minWidth={0}
                        flexShrink={0}
                        wrapMode="word"
                        fg={card().included ? card().accent : color.excluded}
                      >
                        <span
                          style={{
                            fg: !card().included
                              ? color.excluded
                              : field().harness
                                ? harnessColors[field().harness!]
                                : color.muted,
                          }}
                        >
                          {`${field().label}: `}
                        </span>
                        <Index each={field().values}>
                          {(value, index) => (
                            <>
                              <Show when={index > 0}>
                                <span
                                  style={{
                                    fg: card().included
                                      ? color.muted
                                      : color.excluded,
                                  }}
                                >
                                  {" · "}
                                </span>
                              </Show>
                              <span
                                style={{
                                  fg: !card().included
                                    ? color.excluded
                                    : value().harness
                                      ? harnessColors[value().harness!]
                                      : color.muted,
                                }}
                              >
                                {safeText(value().text)}
                              </span>
                            </>
                          )}
                        </Index>
                      </text>
                    )}
                  </Index>
                </box>
              )}
            </Show>
            <Index each={card().files}>
              {(file, index) => (
                <Show
                  when={
                    !card().nested ||
                    file().path === "SKILL.md" ||
                    opened().has(fileId(cardIndex, file().path))
                  }
                >
                  <box
                    id={
                      card().instructions
                        ? `kit-preview:${safeText(props.item.key)}:instructions:${index}`
                        : undefined
                    }
                    minWidth={0}
                    width="100%"
                    flexDirection="column"
                    flexShrink={0}
                    marginTop={
                      (card().instructions || card().metadata) && index > 0
                        ? 1
                        : 0
                    }
                  >
                    <Show when={card().nested && file().path !== "SKILL.md"}>
                      <text
                        id={fileHeaderId(fileId(cardIndex, file().path))}
                        width="100%"
                        minWidth={0}
                        fg={card().included ? color.muted : color.excluded}
                        wrapMode="word"
                        flexShrink={0}
                        marginTop={1}
                        onMouseDown={(event) => {
                          if (event.button !== 0) return
                          event.stopPropagation()
                          toggleFile(fileId(cardIndex, file().path))
                        }}
                      >
                        {safeText(file().path)}
                      </text>
                    </Show>
                    <Show
                      when={typeof file().content === "string"}
                      fallback={
                        <text
                          fg={file().included ? color.muted : color.excluded}
                          wrapMode="word"
                          flexShrink={0}
                        >
                          {`Raw asset · ${resourceSize(file().content).toLocaleString("en-US")} bytes · copied unchanged`}
                        </text>
                      }
                    >
                      <Content
                        content={file().content as string}
                        markdown={file().markdown}
                        included={file().included}
                        skill={card().nested && file().path === "SKILL.md"}
                      />
                    </Show>
                  </box>
                </Show>
              )}
            </Index>
          </box>
        )}
      </Index>
      <Show when={props.scope === "both"}>
        <text fg={color.muted} wrapMode="word" flexShrink={0}>
          Both retains repository intent while using only the global copy.
          Removing global restores known repository copies.
        </text>
      </Show>
    </box>
  )
}
