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

## Develop

```sh
mise run check
mise run build
mise exec -- bun dist/cli.js --help
```

Bun runs OpenTUI’s Solid integration; npm manages the local dependency lockfile. See [architecture](site/reference.html#development), [kit authoring](site/reference.html#kits), [output settings](site/reference.html#settings), and [safety/recovery](site/reference.html#safety).

MIT. See [bundled-content attribution](site/reference.html#attribution).
