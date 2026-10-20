import { createEffect, For, type Accessor } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import { theme } from "./theme"

export const walkthroughPages = [
  {
    title: "Build your loadout",
    subtitle: "Reusable context, chosen by you.",
    wide: [
      "+-----------+     +-----------+     +----------------+",
      "|  Browse   | --> | Configure | --> | Review & apply |",
      "+-----------+     +-----------+     +----------------+",
    ],
    compact: [
      "[ Browse ]",
      "     |",
      "     v",
      "[ Configure ]",
      "     |",
      "     v",
      "[ Review & apply ]",
    ],
    sections: [
      {
        title: "Browse",
        body: "Catalogs contain kits: bundles of instructions, skills, and other agent context. Highlight a catalog or kit to preview it.",
        color: theme.file,
      },
      {
        title: "Choose",
        body: "Space opens a catalog; Space on a kit opens its questions. Nothing is installed just by browsing.",
        color: theme.sage,
      },
    ],
  },
  {
    title: "Configure, then accept",
    subtitle: "Your answers shape the live preview.",
    wide: [
      "+------------------+       +-------------------+",
      "| Scope + answers  | ----> | Live kit preview  |",
      "+------------------+       +-------------------+",
      "          |",
      "       Accept ---> Staged (not written)",
    ],
    compact: [
      "[ Scope + answers ]",
      "         |",
      "         v",
      "[ Live preview ]",
      "         |",
      "      Accept",
      "         v",
      "[ Staged only ]",
    ],
    sections: [
      {
        title: "Repository",
        body: "Use the kit in this project only.",
        color: theme.repository,
      },
      {
        title: "Global",
        body: "Use the kit across projects.",
        color: theme.global,
      },
      {
        title: "Both",
        body: "Use the global copy now; retain this project's intent as a fallback. No duplicate repository copy.",
        color: theme.both,
      },
      {
        title: "Stay in control",
        body: "Arrows move between questions and options; Space selects. Text inputs type normally. Enter finishes typing. Accept or Esc stages the kit; only Cancel discards the open edit.",
        color: theme.sage,
      },
    ],
  },
  {
    title: "Choose how outputs are managed",
    subtitle: "Defaults work; Settings makes them yours.",
    wide: [
      "+-----------------+       +--------------------+",
      "| First location  | ----> | More locations     |",
      "| canonical copy  |       | Copy (default)     |",
      "+-----------------+       | or Link to first   |",
      "                          +--------------------+",
    ],
    compact: [
      "[ First location ]",
      "         |",
      "         v",
      "[ More locations ]",
      "  Copy or Link",
    ],
    sections: [
      {
        title: "Output locations",
        body: "Settings controls repository and global destinations. Copy is the default. Link points additional managed files to the first location, not entire skill directories.",
        color: theme.file,
      },
      {
        title: "Ignore rules: None by default",
        body: "Optional Shared or Local rules cover managed repository outputs only. They never untrack files or ignore kit definitions.",
        color: theme.muted,
      },
      {
        title: "Still only a draft",
        body: "Accept stages settings. Review shows exact resolved paths and link targets before you approve any writes.",
        color: theme.sage,
      },
    ],
  },
  {
    title: "Review first. Apply deliberately.",
    subtitle: "You decide when files change.",
    wide: [
      "+---------+     +-----------------+     +---------+",
      "| Staged  | --> | Review changes  | --> | Apply   |",
      "+---------+     | paths + content |     +---------+",
      "                +-----------------+",
      "                  | Keep editing",
      "                  +----> No writes",
    ],
    compact: [
      "[ Staged ]",
      "     |",
      "     v",
      "[ Review changes ]",
      "     |",
      "     +--> Keep editing",
      "     |    (no writes)",
      "     v",
      "[ Apply changes ]",
    ],
    sections: [
      {
        title: "Review & apply",
        body: "Tab to Review to inspect changes and exact output paths. Keep editing is selected first. Select Apply changes, then press Space to write files and save your choices.",
        color: theme.warning,
      },
      {
        title: "Prefer working with an agent?",
        body: "Ask your agent to start with loadout guide, discover kits, ask you their questions, and prepare a plan. Review that plan before authorizing apply.",
        color: theme.sage,
      },
      {
        title: "Come back anytime",
        body: "Press ? outside a form to replay this guide. Viewing it never stages kits, changes output settings, or applies files.",
        color: theme.muted,
      },
    ],
  },
] as const

/** A read-only surface: it has no model or installation-service access. */
export function Walkthrough(props: {
  page: Accessor<number>
  width: number
  scrollRef: (ref: ScrollBoxRenderable) => void
}) {
  let scroll: ScrollBoxRenderable | undefined
  createEffect(() => {
    props.page()
    scroll?.scrollTo(0)
  })
  const page = () => walkthroughPages[props.page()]!
  // Diagrams use ASCII only and have narrow variants; exceptionally small
  // terminals show the same flow as wrapped text rather than clipped art.
  const diagram = () =>
    props.width < 29
      ? ["Browse > Configure > Review > Apply"]
      : props.width < 65
        ? page().compact
        : page().wide
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      backgroundColor={theme.panel}
      border
      borderStyle="rounded"
      borderColor={theme.sage}
      title={`Welcome / Walkthrough ${props.page() + 1} of ${walkthroughPages.length}`}
      flexDirection="column"
      paddingX={1}
    >
      <scrollbox
        ref={(ref: ScrollBoxRenderable) => {
          scroll = ref
          props.scrollRef(ref)
        }}
        flexGrow={1}
        minHeight={0}
        scrollX={false}
        contentOptions={{ flexDirection: "column", gap: 1 }}
      >
        <box flexDirection="column" flexShrink={0}>
          <text fg={theme.sage} wrapMode="word" flexShrink={0}>
            {page().title}
          </text>
          <text fg={theme.muted} wrapMode="word" flexShrink={0}>
            {page().subtitle}
          </text>
        </box>
        <text fg={theme.sage} wrapMode="word" flexShrink={0}>
          {diagram().join("\n")}
        </text>
        <For each={page().sections}>
          {(section) => (
            <box flexDirection="column" minWidth={0} flexShrink={0}>
              <text fg={section.color} wrapMode="word" flexShrink={0}>
                {section.title}
              </text>
              <text fg={theme.text} wrapMode="word" flexShrink={0}>
                {section.body}
              </text>
            </box>
          )}
        </For>
      </scrollbox>
      <text fg={theme.sage} wrapMode="word" flexShrink={0}>
        {`${props.page() ? "Left/h: Back  |  " : ""}${props.page() === walkthroughPages.length - 1 ? "Enter/Space: Start browsing" : "Right/l/Space: Next"}  |  Esc: Skip`}
      </text>
    </box>
  )
}
