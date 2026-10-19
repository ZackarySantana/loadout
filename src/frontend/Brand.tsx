import { Show } from "solid-js"
import { theme } from "./theme"

const letters = [
  ["   ", "|  ", "|__"],
  [" _ ", "| |", "|_|"],
  [" _ ", "|_|", "| |"],
  ["_  ", "| \\", "|_/"],
  [" _ ", "| |", "|_|"],
  ["   ", "| |", "|_|"],
  ["___", " | ", " | "],
]
const wordmark = [0, 1, 2]
  .map((line) => letters.map((letter) => letter[line]).join(" "))
  .join("\n")

export function Brand(props: { compact: boolean }) {
  return (
    <Show
      when={!props.compact}
      fallback={
        <text
          id="loadout-brand-compact"
          fg={theme.sage}
          flexShrink={0}
          height={1}
        >
          LOADOUT
        </text>
      }
    >
      <text
        id="loadout-wordmark"
        width={27}
        height={3}
        flexShrink={0}
        fg={theme.sage}
        wrapMode="none"
      >
        {wordmark}
      </text>
    </Show>
  )
}
