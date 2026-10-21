# Loadout

Compose project and user-wide agent context from declarative kits. Choose instructions, skills, native subagents, and supporting files, answer questions, review exact changes, then apply. Destination defaults support Codex, Claude Code, and OpenCode.

**[Read the documentation →](site/index.html)** · [Technical reference](site/reference.html) · [Team example](examples/team-catalog/)

## Run from this checkout

Use the pinned runtimes with [mise](https://mise.jdx.dev/). Loadout is not an npm-published CLI.

```sh
mise trust
mise install
mise exec -- npm install
mise run dev
```

Configure another project:

```sh
mise exec -- npm run dev -- --repo /path/to/project
```

Browse with arrows and Space; configure a kit, accept its draft, then review. Only explicitly choosing **Apply changes** writes the plan. **Esc accepts** an open kit; use its **Cancel** action to discard edits. Press **q twice** to exit.

While browsing a catalog, **Search kits** filters names, IDs, and descriptions. The bar and query stay in place during kit configuration; search editing is locked until Accept/Cancel. Press **/** outside forms/text editing to type; Enter/Esc keeps the filter and returns to browsing. Up/Down navigates matches. Search is case-insensitive; every space-separated term must match. This helps browse larger remote catalogs without searching resource contents.

Matt Pocock, Anthropic, and Ponytail have separate remote catalogs: browse a catalog to load its upstream skill directories, without requiring upstream catalog JSON. They are not vendored Loadout kits. Updates use file-content hashes, not commit IDs or dates; Review keeps installed content by default and asks before adopting an update. See [remote sources](site/reference.html#catalogs) and [update safety](site/reference.html#drift).

Remote inventories are cached across launches. Catalog rows show colored names, available kit counts, and, only after a full day since checking, **stale by N days** on the same line. In the TUI, opening a stale catalog asks whether to update its inventory: **No** keeps the current inventory without fetching; **Yes** refreshes it. Younger catalogs open immediately without a background refresh. Unchanged resource bytes are reused, and installed kits never update merely because a catalog was refreshed. Review and Apply still validate current upstream content before accepting a kit update.

Some upstream entries require fonts, PDFs, archives, or other non-text resources that this adapter cannot yet install. Those entries are listed as unavailable in their catalog; they are not problems with unrelated installed kits. Installed status reports actual source or managed-file issues for your installations.

Remote catalog loading reports its current stage in the status area. Once discovery determines the inventory, a progress bar counts kits checked, including those reported unavailable; it is not an estimate of bytes or time remaining.

## Read the docs locally

Open [`site/index.html`](site/index.html) directly in your browser—no build or server required. Or serve with the existing Bun runtime:

```sh
mise exec -- npm run docs
```

Visit **http://127.0.0.1:4173** (`PORT` may override the port). The server binds loopback only. Assets are relative; no CDN, external scripts, or tracking. No GitHub Pages publication or deployment workflow is configured.

## Set up with your agent

Point your agent at this checkout’s [`AGENTS.md`](AGENTS.md), or ask it to start with:

```sh
mise exec -- bun src/cli.tsx guide
```

The agent discovers available kits, asks your preferences and configuration questions, and prepares a plan. You approve the exact review token before apply; the agent must never self-approve. See the [question-driven workflow and approval contract](site/reference.html#agent-workflow).

Initial inspection shows cached inventory where available and lazy headers otherwise. To explore one explicitly, use `mise exec -- bun src/cli.tsx inspect --json --catalog matt-pocock --repo /path/to/project`; add `--fresh` for a live check. An unloaded catalog is not an empty catalog. Planning and applying catalog-selected content always use fresh validation.

## Develop

```sh
mise run check
mise run build
mise exec -- bun dist/cli.js --help
```

Bun runs OpenTUI’s Solid integration; npm manages the local dependency lockfile. See [architecture](site/reference.html#development), [kit authoring](site/reference.html#kits), [output settings](site/reference.html#settings), and [safety/recovery](site/reference.html#safety).

Historical context-comparison fixtures and licenses live under `site/evidence/`, separate from runtime catalogs. Regenerate their measurement inventory and downloadable extract offline with `mise exec -- bun scripts/measure-context.ts`; review the static HTML tables against the result. This never fetches remote content or generates kit YAML.

MIT. See [bundled-content attribution](site/reference.html#attribution).
