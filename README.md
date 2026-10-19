# Loadout

Compose project and user-wide agent context from catalogs of declarative kits. A kit can contribute instructions to `AGENTS.md` / `CLAUDE.md`, skills, and other text files, with inline configuration questions.

## Develop

Use the project’s pinned Node and Bun runtimes through [mise](https://mise.jdx.dev/):

```sh
mise trust
mise install
mise exec -- npm install
mise run dev
```

Open another project with `mise exec -- npm run dev -- --repo /path/to/project`.

```sh
mise run check
mise run build
mise exec -- bun dist/cli.js --help
```

Dependencies are local to the project. OpenTUI’s Solid integration runs on Bun; npm manages the dependency lockfile.

## Choose, review, apply

- **Catalogs** starts with the permanent Loadout catalog. Highlight a catalog to preview its kits in separate cards with descriptions and contribution badges; **Space** opens it.
- Kit entries are spaced apart, with muted italic descriptions beneath their names. Highlight one to preview its contributions as Markdown sections with titled separators. Instructions share one combined section, with disabled fragments shown in gray. Answers update in place as you type. **Space** expands configuration directly beneath the entry.
- Use **↑ / ↓** or **j / k** between rows, **← / →** or **h / l** to focus horizontal options, and **Space** to select or toggle. Options wrap on narrow screens; focus highlighting is separate from the selected radio/check markers. Landing on a text answer starts typing automatically; Vim keys then enter text instead of navigating. **↑ / ↓** still move between questions. **Enter** finishes only the input; **Esc** accepts/stages the whole kit, including while typing. Required-answer errors keep the form open. Choose **Accept** to stage or **Cancel** to discard the edit; these actions share one horizontal row.
- An open kit keeps navigation inside its form. Accept or cancel it to return to the kit list; other kits cannot receive focus while you are configuring it.
- Text answers stay visible on their own line below the question, aligned with its text. Optional question descriptions appear as muted italic help below the control.
- **↑ / ↓** wrap at list boundaries. Inside an open kit, they wrap between its first and last form controls without leaving the kit.
- **Tab** / **Shift+Tab** cycle Catalogs, Installed, and Review. Finish or cancel an open form first.
- **Review** lists actual file changes, staged scope/answers, and safety details in sections. Highlight a file for its colored diff. The visible **Apply changes / Keep editing** row defaults to **Keep editing**. Explicitly focus **Apply changes** with **← / →** or **h / l**, then press **Space** to write all listed files and save installation intent. This is the final confirmation, with no second menu. Applying still saves intent and answers when there are zero file changes. **Keep editing** returns to Installed with drafts intact and a fresh plan on the next Review; reviewing never writes files.
- **Esc** accepts an open kit; only its explicit **Cancel** action discards the edit. Outside a kit, **Esc** goes back or stops catalog input; **PgUp / PgDn** scroll the informational column. Press **q** twice to exit, even with no changes: the first opens confirmation, the second exits. **Esc** stays; **Space** does not confirm. **Ctrl+C** opens the same prompt. While typing an answer, **q** is literal text.

### Installation scope

Scope colors are consistent wherever shown: **Repository** is blue, **Global** gold, and **Both** lavender. Instructions use sage accents, skills lavender, and other files blue. Excluded contributions are gray; labels and selection markers remain visible alongside colors.

**Repository** keeps a kit in this project. **Global** keeps it in your user configuration. **Both** retains both intentions but materializes only the global copy.

When a global kit is removed, Loadout restores copies in every known repository that retained repository intent, with that repository’s saved answers. Adding it globally suppresses those repository copies again. Review includes all affected repositories, not just the current one. Tab transitions refresh persisted scope from other sessions.

Choose **Not installed** to clear global intent and this project’s repository intent; other projects’ intent is retained. To remove only global intent while retaining this project’s fallback, choose **Repository**.

Instructions go to project-root `AGENTS.md` and `CLAUDE.md`, or globally to `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`. Skills go to both `.agents/skills/` and `.claude/skills/`. Those are separate CLI destinations, not duplicate installations across scopes.

## Catalogs and kits

Register a local `catalog.json` or HTTPS URL using the Catalogs page, or:

```sh
mise exec -- bun src/cli.tsx catalog add /path/to/catalog.json
mise exec -- bun src/cli.tsx catalog list
mise exec -- bun src/cli.tsx catalog remove /path/to/catalog.json
```

Catalog registration updates the registry immediately; it never installs kit files. Catalog removal retains installed kit snapshots, so they can still be managed from Installed. Local catalog paths resolve relative to the selected project. Remote catalogs must use HTTPS without redirects; kit references stay within their catalog’s directory and origin. Registered sources are read when launching, so remote catalogs currently need a network connection. Installed snapshots remain usable if a source becomes unavailable.

See [catalog authoring](docs/catalogs.md) and [kit authoring](docs/kits.md). Kits only interpolate text and evaluate declarative conditions. They cannot execute code, run hooks, interpolate paths, or write through symlinks. Review third-party content before applying it: generated agent instructions and skills can still influence an agent’s behavior.

## Safety and state

Loadout stores catalog registrations, intent, configured kit snapshots, known repository paths, and managed-file records in `~/.loadout/state.json`. Answers are stored as plain text: do not enter secrets. Repository intent is local to the current user; this first implementation does not share selections through Git or migrate v1 state.

Existing instructions outside Loadout’s marked blocks are preserved. Existing unrelated files and externally edited managed content block changes rather than being overwritten. Review is read-only; apply checks for concurrent state/file edits and uses a write-ahead journal for rollback. Keep known repositories accessible when changing global scope; an inaccessible or conflicted repository can block a safe apply.

An interrupted process can leave `~/.loadout/lock`. Close other Loadout sessions and verify that no apply is running before manually removing that specific lock file. **Keep `journal.json`**: the next launch rolls back an incomplete apply, or finishes cleanup if state was already committed. If a file changed after interruption, recovery stops for manual inspection instead of overwriting it. Atomic replacement preserves permission bits, but does not promise preservation of extended attributes, ACLs, or hard-link relationships. Transaction recovery is not a substitute for backups.

## Code layout

- `src/domain/`: strict declarative schemas, answer validation, conditions, interpolation; no frontend or filesystem dependencies.
- `src/backend/`: catalogs, persistent intent, rendering, conflict-safe planning, transactional apply/recovery; no Solid or OpenTUI dependencies.
- `src/frontend/model.ts`: page/navigation/form state, depending only on the backend interface.
- `src/frontend/App.tsx`: Solid/OpenTUI rendering and keyboard wiring; no filesystem access.
- `test/`: isolated backend flows and real OpenTUI keyboard flows.

MIT. Bundled first-party kit text is adapted from Loadout v1; attribution is included in the authoring docs.
