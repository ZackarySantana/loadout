import { For } from "solid-js"
import { theme } from "./theme"

const steps = [
  {
    title: "1 · Browse",
    body: "Open a catalog with Space.",
    color: theme.file,
  },
  {
    title: "2 · Configure",
    body: "Answer questions, then choose Accept.",
    color: theme.sage,
  },
  {
    title: "3 · Review & apply",
    body: "Tab to Review. Confirm to write files.",
    color: theme.warning,
  },
]

export function GuidePreview() {
  return (
    <box
      width="100%"
      minWidth={0}
      flexDirection="column"
      flexShrink={0}
      gap={1}
    >
      <For each={steps}>
        {(step) => (
          <box
            width="100%"
            minWidth={0}
            flexDirection="column"
            flexShrink={0}
            border
            borderStyle="rounded"
            borderColor={theme.border}
            paddingX={1}
          >
            <text fg={step.color} wrapMode="word" flexShrink={0}>
              <b>{step.title}</b>
            </text>
            <text fg={theme.text} wrapMode="word" flexShrink={0}>
              {step.body}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}
