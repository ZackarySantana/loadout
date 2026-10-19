# Catalogs

A catalog is a JSON index of declarative YAML kits. The bundled Loadout catalog at [`catalog/catalog.json`](../catalog/catalog.json) is permanent: it is always available, not a user-removable registration. Its entries reference files in `catalog/kits/`.

## JSON shape

```json
{
  "id": "team",
  "name": "Team kits",
  "description": "Shared project guidance.",
  "kits": [
    {
      "id": "review",
      "name": "Review changes",
      "description": "Review changes for actionable defects.",
      "source": "kits/review.yaml"
    }
  ]
}
```

The exact shape is `{id,name,description,kits:[{id,name,description,source}]}`. Unknown fields are rejected. `id` uses lowercase letters, digits, and hyphens, beginning with a letter or digit. Catalog and entry names must be nonempty. Descriptions are strings and default to empty when omitted. `kits` is required; entry IDs must be unique within the catalog. `source` is a nonempty string pointing to a kit YAML document. Keep entry IDs, names, and descriptions aligned with the referenced kits.

Relative sources resolve against the catalog's location, not the shell's working directory. A local catalog at `/work/team/catalog.json` with `source: "kits/review.yaml"` refers to `/work/team/kits/review.yaml`. For a catalog fetched over HTTPS, the same source resolves relative to its URL. Local kit references must remain within the catalog directory after resolving symlinks. Remote kit references must remain within the catalog URL's directory and origin; cross-origin URLs and parent-directory escapes are rejected. Prefer relative sources. A source locates declarative data; it never names a command to run.

Each kit is self-contained. Its output text is inline YAML, not another set of source references. See [kit authoring](kits.md) for questions, conditions, interpolation, and outputs. Catalog registration and kit scope are application state; neither belongs in the catalog JSON or kit YAML.

## Share a catalog through a repository

Commit a catalog and its kit files alongside the team's code:

```text
.loadout/
  catalog.json
  kits/
    team-review.yaml
```

Loadout discovers `.loadout/catalog.json` in the selected project. Team members see the catalog without registering it for their entire user account. Discovery only makes kits available; each member independently selects and configures the kits they want. Choosing Repository installs a kit in that member's checkout.

The [team catalog example](../examples/team-catalog/) is a complete, copyable example. Use an organization-specific catalog ID, such as `acme-team`, and keep it stable: catalog and kit IDs identify the same logical kit across checkouts.

For catalogs elsewhere in the checkout, commit a `.loadout/catalogs.json` subscription file:

```json
{
  "catalogs": [
    "tools/agent-context/catalog.json",
    "https://example.com/team/catalog.json"
  ]
}
```

This file contains only `catalogs`, an array of source strings. Local references resolve relative to the **repository root**, remain inside that checkout, and are stored as relative paths so teammates can clone into different directories. HTTPS references are also supported. Kit references inside each catalog still resolve relative to that catalog, as described above.

Register another project subscription with:

```sh
loadout catalog add tools/agent-context/catalog.json --scope repository
```

Repository is the default subscription scope. Use `--scope global` for a catalog you want available in all your projects. Catalog subscription scope controls **availability**, not installation: subscribing does not install any kit, and each kit still has its own Repository / Global / Both choice.

Repository subscription changes edit `.loadout/catalogs.json`, which is intended to be shared through Git. Review that file before committing it. Do not commit credentials in source URLs; keep private user-specific references in global subscriptions instead.

Loadout refuses to replace the subscription file if it detects an editor or Git changing it during registration. Retry after reconciling the file. An interrupted registration can leave `.loadout/catalogs.json.lock`; verify that no Loadout writer is running before removing that specific lock. The lock and temporary replacement files are local working files, not catalog data to commit.

## Missing sources and drift

Subscriptions read live catalog and kit files, not imported copies. Installed kits retain their saved definition and answers so that a missing catalog, removed kit, invalid YAML, or temporary network failure does not uninstall or silently change existing files. One unavailable kit does not hide healthy kits from the same catalog.

Loadout reports changes between an installed snapshot and its current catalog definition. Updating is explicit: choose the catalog update, review compatible saved answers and any new questions, then use Review and Apply changes. Until then, the saved installation stays in effect. Source disappearance is a warning, not permission to delete installed files.

`loadout status` also reports modified, missing, unreadable, or unsafe managed output paths. Changes to user text **outside** managed instruction blocks are preserved and do not count as managed-content drift. Status inspection does not repair or overwrite files; output conflicts still block apply. Resolve those edits deliberately before retrying.

Drift compares current content to saved snapshots. It does not introduce catalog versions, revision histories, or automatic upgrades.

## Bundled content and attribution

The first-party `greenfield`, `no-em-dash`, `dont-commit`, `codex-cli`, `claude-cli`, `opencode-cli`, and `write-kit` kits are adapted from Loadout v1's `kits/loadout/` and `kits/loadout-agent-clis/` directories, copyright 2026 Loadout contributors, under the [MIT license](../LICENSE). The license is copied unchanged from v1.

The plain instruction kits preserve the original text. CLI kits retain the instructions-or-skill choice using v2 questions and inline outputs. Codex and Claude examples use the configured default model instead of retaining old hard-coded model names. `write-kit` is rewritten for the current declarative authoring format. `project-context` is a new example demonstrating all question types, conditional questions and outputs, content interpolation, a skill with supporting Markdown, and an optional file. No external kits are bundled.

Bundled instructions are data, not rules governing Loadout's development. In particular, `dont-commit` only contributes instructions when a user selects and applies that kit.
