import { createEffect, createMemo, Index, onCleanup, Show } from "solid-js"
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
} from "@opentui/core"
import {
  activeAnswers,
  defaults,
  matches,
  type Answers,
  type LoadedKit,
  type Scope,
} from "../domain/kit"
import { theme as color } from "./theme"

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
}
interface Contribution {
  label: string
  accent: string
  included: boolean
  files: {
    path: string
    content: string
    markdown: boolean
    included: boolean
  }[]
  nested: boolean
  instructions: boolean
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
    // Terminal newlines otherwise add empty layout rows on top of the single
    // section gap. Normalize only the displayed preview, never the kit payload.
    const content = createMemo(() => interpolate(parts().body).trimEnd())
    const syntaxStyle = createMemo(() =>
      contentProps.included ? includedStyle : excludedStyle,
    )
    let markdown: MarkdownRenderable | undefined
    createEffect(() => {
      const style = syntaxStyle()
      content()
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
      <>
        <Show when={metadata()}>
          <text
            width="100%"
            minWidth={0}
            flexShrink={0}
            wrapMode="word"
            fg={contentProps.included ? color.muted : color.excluded}
            marginBottom={content() ? 1 : 0}
          >
            {metadata()}
          </text>
        </Show>
        <Show
          when={contentProps.markdown}
          fallback={
            <text
              width="100%"
              minWidth={0}
              flexShrink={0}
              wrapMode="word"
              fg={contentProps.included ? color.text : color.excluded}
            >
              {content()}
            </text>
          }
        >
          {/* Top-level streaming keeps full-width paragraph nodes and supplies
            styled text immediately, rather than hiding it until highlighting
            finishes. Actual edits and exclusion changes update in place. */}
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
            content={content()}
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
          files: Object.entries(output.files).map(([path, content]) => ({
            path,
            content,
            markdown: /\.(?:md|markdown|mdown|mkd)$/i.test(path),
            included,
          })),
          nested: true,
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
        >{` * ${safeText(props.item.key)}`}</span>
      </text>
      <Show when={props.item.kit.description}>
        <Content content={props.item.kit.description} markdown included />
      </Show>
      {/* Native Markdown descendants can measure one cell wider than their
          container. Keep a gutter inside the details panel's content bounds. */}
      <Index each={contributions()}>
        {(card) => (
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
            <Index each={card().files}>
              {(file, index) => (
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
                  marginTop={card().instructions && index > 0 ? 1 : 0}
                >
                  <Show when={card().nested && file().path !== "SKILL.md"}>
                    <text
                      width="100%"
                      minWidth={0}
                      fg={card().included ? color.muted : color.excluded}
                      wrapMode="word"
                      flexShrink={0}
                      marginTop={1}
                    >
                      {safeText(file().path)}
                    </text>
                  </Show>
                  <Content
                    content={file().content}
                    markdown={file().markdown}
                    included={file().included}
                    skill={card().nested && file().path === "SKILL.md"}
                  />
                </box>
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
