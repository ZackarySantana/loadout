import { createMemo, Index, onCleanup, Show } from "solid-js"
import { useRenderer } from "@opentui/solid"
import {
  SyntaxStyle,
  TextRenderable,
  type MarkdownOptions,
  type StyleDefinitionInput,
} from "@opentui/core"
import {
  activeAnswers,
  defaults,
  matches,
  type Answers,
  type LoadedKit,
  type Scope,
} from "../domain/kit"
import { theme as color, scopeColor } from "./theme"

// Preserve line breaks and tabs, but never pass terminal controls through.
const safeText = (text: string) =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")

function styles(excluded: boolean): Record<string, StyleDefinitionInput> {
  const body = excluded ? color.excluded : color.text
  const accent = excluded ? color.excluded : color.sage
  return {
    default: { fg: body },
    conceal: { fg: excluded ? color.excluded : color.border },
    "markup.heading": { fg: accent, bold: true },
    "markup.heading.1": { fg: accent, bold: true },
    "markup.heading.2": { fg: accent, bold: true },
    "markup.heading.3": { fg: accent, bold: true },
    "markup.heading.4": { fg: accent, bold: true },
    "markup.heading.5": { fg: accent, bold: true },
    "markup.heading.6": { fg: accent, bold: true },
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
  files: { path: string; content: string; markdown: boolean }[]
  nested: boolean
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
  const renderNode: NonNullable<MarkdownOptions["renderNode"]> = (
    token,
    context,
  ) => {
    if (token.type !== "code") return undefined
    return new TextRenderable(renderer, {
      content: safeText(token.text),
      fg: context.syntaxStyle.getStyle("markup.raw")?.fg,
      width: "100%",
      minWidth: 0,
      flexShrink: 0,
      wrapMode: "word",
    })
  }

  const Content = (contentProps: {
    content: string
    markdown: boolean
    included: boolean
  }) => {
    const content = createMemo(() => interpolate(contentProps.content))
    // Native Markdown can retain stale paragraph widths on content updates and
    // stale code/rule colors on style updates. Replace only this renderer when
    // its actual displayed content or inclusion changes, not the surrounding
    // cards/scrollbox or previews unaffected by the edited answer.
    const markdown = createMemo(() => ({
      content: content(),
      syntaxStyle: contentProps.included ? includedStyle : excludedStyle,
    }))
    return (
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
        <Show when={markdown()} keyed>
          {(snapshot) => (
            // Set style before content: OpenTUI parses content immediately.
            <markdown
              width="100%"
              minWidth={0}
              flexShrink={0}
              syntaxStyle={snapshot.syntaxStyle}
              fg={snapshot.syntaxStyle.getStyle("default")?.fg}
              conceal
              renderNode={renderNode}
              tableOptions={{
                wrapMode: "word",
                widthMode: "full",
                cellPaddingX: 0,
              }}
              content={snapshot.content}
            />
          )}
        </Show>
      </Show>
    )
  }

  const contributions = createMemo(() =>
    props.item.kit.outputs.flatMap<Contribution>((output) => {
      const included = matches(output.when, answers())
      if (output.type === "instructions")
        return output.targets.map((target) => ({
          label: `Instructions · ${target}`,
          accent: color.instructions,
          included,
          files: [{ path: target, content: output.content, markdown: true }],
          nested: false,
        }))
      if (output.type === "skill")
        return [
          {
            label: `Skill · ${output.name}`,
            accent: color.skill,
            included,
            files: Object.entries(output.files).map(([path, content]) => ({
              path,
              content,
              markdown: /\.(?:md|markdown|mdown|mkd)$/i.test(path),
            })),
            nested: true,
          },
        ]
      return [
        {
          label: `File · ${output.path}`,
          accent: color.file,
          included,
          files: [
            {
              path: output.path,
              content: output.content,
              markdown: /\.(?:md|markdown|mdown|mkd)$/i.test(output.path),
            },
          ],
          nested: false,
        },
      ]
    }),
  )

  return (
    <box
      width="100%"
      minWidth={0}
      flexDirection="column"
      flexShrink={0}
      gap={1}
    >
      <text fg={color.sage} wrapMode="word" flexShrink={0}>
        <b>{safeText(props.item.kit.name)}</b>
      </text>
      <Show when={props.item.kit.description}>
        <Content content={props.item.kit.description} markdown included />
      </Show>
      <text fg={color.muted} wrapMode="word" flexShrink={0}>
        {`${safeText(props.item.key)}\nScope: `}
        <span style={{ fg: scopeColor(props.scope) }}>{props.scope}</span>
      </text>
      <text fg={color.muted} flexShrink={0}>
        CONTRIBUTIONS
      </text>
      <Index each={contributions()}>
        {(card) => (
          <box
            width="100%"
            minWidth={0}
            flexDirection="column"
            flexShrink={0}
            border
            borderStyle="rounded"
            borderColor={card().included ? card().accent : color.excluded}
          >
            <text
              fg={card().included ? card().accent : color.excluded}
              wrapMode="word"
              flexShrink={0}
            >
              <b>{safeText(card().label)}</b>
            </text>
            <Show when={!card().included}>
              <text fg={color.excluded} flexShrink={0}>
                Not included
              </text>
            </Show>
            <Index each={card().files}>
              {(file) => (
                <box
                  minWidth={0}
                  width="100%"
                  flexDirection="column"
                  flexShrink={0}
                >
                  <Show when={card().nested}>
                    <text
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
                    included={card().included}
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
