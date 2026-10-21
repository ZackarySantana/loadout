# Loadout

Compose project and user-wide agent context from declarative kits. Choose instructions, skills, native subagents, and supporting files, answer questions, review exact changes, then apply. Destination defaults support Codex, Claude Code, and OpenCode.

**[Read the documentation →](site/index.html)** · [Technical reference](site/reference.html) · [Team example](examples/team-catalog/)

## Install from npm

After this version is released, use Node.js **26.4 or newer**, then:

```sh
npm install --global @lidtop/loadout
loadout
```

The npm CLI runs on Node.js; **Bun is not required by users**. The package includes the built CLI and bundled catalog, not this development checkout. Bun is used only for development, testing, and building releases.

OpenTUI currently uses Node’s experimental FFI API. The CLI enables it automatically; Node may print an experimental-feature warning.

## Run from this checkout

Use the pinned runtimes with [mise](https://mise.jdx.dev/).

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

Remote skills preserve their supporting files, including fonts, PDFs, and archives, byte-for-byte. Raw assets are copied without interpretation, previews, execution, or extraction; their presence does not raise warnings or disable a skill. Required text definitions and license notices, source integrity, and resource bounds remain validated normally. Installed status reports actual source or managed-file issues for your installations.

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
mise exec -- node --experimental-ffi dist/cli.js --help
```

Bun runs source development and tests, and builds the Node-targeted CLI; npm manages the local dependency lockfile. See [architecture](site/reference.html#development), [kit authoring](site/reference.html#kits), [output settings](site/reference.html#settings), and [safety/recovery](site/reference.html#safety).

## Release to npm

The CI and release workflows mirror Opcode’s pinned actions, mise setup, release PRs, and npm OIDC publishing, adapted to this single package and npm lockfile.

1. Include a release note with a code change using `mise exec -- npm run changeset`. Select a patch, minor, or major bump and commit the generated `.changeset/*.md` file with your change.
2. After merging to `main`, `.github/workflows/release.yml` opens or updates a versioned release PR, such as **chore(release): publish Loadout v0.5.1**, proposing the combined version bump and changelog. Its title is refreshed automatically as the proposed version changes.
3. Review and merge that release PR to publish. The publish job reruns checks, builds the package, and publishes only an unpublished version using npm provenance. Already published versions are skipped on subsequent pushes. Stable releases use `latest`; prerelease versions use `next`.

Creating a GitHub Release or pushing a tag is not required. The workflow does not automatically create GitHub Releases.

For matching commits on `main`, configure squash merging to use the **pull request title and description**. The bot's intermediate versioning commit can remain generic; the final squash commit inherits the versioned PR title and release notes.

One-time setup:

1. In GitHub **Settings → Actions → General → Workflow permissions**, enable **Allow GitHub Actions to create and approve pull requests**. The workflow grants the release-PR job its required write permissions; the default repository token can remain read-only. No bot approval of release PRs is configured.
2. Create the GitHub environment **`npm`**; optionally require maintainer approval. If restricting deployment branches, allow **`main`**.
3. In the npm package’s **Settings → Trusted publishing**, authorize GitHub user **`ZackarySantana`**, repository **`loadout`**, workflow filename **`release.yml`**, and environment **`npm`**. Enable **Allow npm publish**; leave **npm dist-tag** disabled. Stage-only permission would require a separate approval on npm and is not used here. No `NPM_TOKEN` secret is needed.
4. npm requires a new trusted-publisher configuration to complete its first successful publish within two days; recreate it if it expires.

Protect `main` with required pull-request review if release approval must be mandatory. As in Opcode, any unpublished version committed to `main` is eligible for publication; do not bypass the release PR by manually committing an unpublished version.

**Before the first release:** this checkout’s `0.0.0` remains a placeholder and is skipped. Restore an already-published baseline in both `package.json` and `package-lock.json` (npm currently has `0.4.4`) before adding your first changeset. Then let the release PR propose the new version. The publish script refuses to move `latest` backwards. No version has been changed or published as part of adding this automation.

GitHub’s default token may not trigger CI on the bot-created release PR. If branch protection requires the CI check, manually run the **CI** workflow on the release PR’s branch (`changeset-release/main`) from Actions. CI supports manual dispatch for this reason; publication also runs the checks after merge.

Historical context-comparison fixtures and licenses live under `site/evidence/`, separate from runtime catalogs. Regenerate their measurement inventory and downloadable extract offline with `mise exec -- bun scripts/measure-context.ts`; review the static HTML tables against the result. This never fetches remote content or generates kit YAML.

MIT. See [bundled-content attribution](site/reference.html#attribution).
