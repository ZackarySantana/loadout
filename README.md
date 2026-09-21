# Loadout

Choose agent skills and instructions for yourself or your team. Loadout configures Codex and Claude Code.

Private kits and selections live in `.loadout-personal/`, ignored by Git. Add reusable kits to `~/.loadout/kits/` and enable them per repository.

## Use it

Requires Node.js **22.13+**. Run in any repository:

```sh
npm install -g @lidtop/loadout
loadout
```

Pick your kits and select **Review changes**. Any kit questions and downloads happen automatically, then one compact review shows your kit changes and file totals for Repository and Global. Expand **Unchanged** to inspect your complete selection, or choose **View files** to browse paths and diffs. Choose **Apply changes** to save, or **Back to kits** to edit your selection. Inside a provider, choose **Back to providers** to keep browsing with your selections preserved. Run `loadout` again to change your selection.

The destination selector above the tabs shows **Repository** in cyan (this repository only) and **Global** in magenta (your user configuration across repositories). Active controls and selection markers follow the destination's color. Press **Tab** to switch destinations instantly, or **Shift+Tab** to cycle backward. **←/→** switches between the Kits, Browse, and Installed sections. Each destination keeps its own selections, provider, search, and cursor position, ready to browse as soon as you switch. A **\*** marks destinations with unapplied selections; **Review changes** includes the session's changes across both. Descriptions appear beneath every provider and kit, with dependency or update notes when needed.

Press **Esc** from review, questions, or downloads to return to your kits. Inside file details, **Esc** returns to the previous view. Your kit choices, completed answers, and picker position are preserved; completed downloads are reused during the session and file plans are rebuilt before review. In review, **↑/↓** scroll and **Tab** moves between actions. Press **Ctrl+C** to cancel setup, or **Esc twice quickly** from the picker. Nothing is applied until you choose **Apply changes**.

Conflicting project instructions are skipped with a warning; the kit’s skills still install.

## Share kits with your team

```sh
loadout init
```

Add kits under `.loadout/kits/` and commit the collection for your team. Enable **Browse → loadout → write-kit** for a short guide your agent can use to create kits.

`loadout --help` lists the commands.

[MIT](LICENSE) · External kits retain their upstream licenses.
