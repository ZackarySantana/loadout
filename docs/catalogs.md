# Catalogs

A catalog groups declarative YAML kits. Loadout includes its permanent built-in catalog, an automatic **Repo** catalog for the selected project, and any external catalogs the user registers.

## Repo: automatic local kits

Commit kit YAML files directly in the project:

```text
.loadout/
  kits/
    team-review.yaml
    deployment.yaml
```

The Repo catalog discovers these YAML files automatically. It needs **no catalog index and no registration step**. Each kit's name, description, questions, and outputs come from its YAML. Members select and configure kits independently; discovering a kit does not apply it.

The [team catalog example](../examples/team-catalog/) is copyable. Repository / Global / Both still describes where a selected kit is applied, not how Repo is registered. Existing project catalog index or subscription files are not used by auto-discovery, and Loadout does not delete them.

## External catalog JSON

External catalogs can be registered by local path or HTTPS URL. The built-in catalog at [`catalog/catalog.json`](../catalog/catalog.json) uses the same index format.

```json
{
  "id": "team",
  "name": "Team kits",
  "kits": [
    {
      "id": "review",
      "name": "Review changes",
      "source": "kits/review.yaml"
    }
  ]
}
```

The exact shape is `{id,name,kits:[{id,name,source}]}`. Unknown fields are rejected. **Descriptions belong only to kit YAML**, not the catalog or its entries. `id` uses lowercase letters, digits, and hyphens, beginning with a letter or digit. Catalog and entry names must be nonempty. `kits` is required; entry IDs must be unique within the catalog. `source` is a nonempty string pointing to a kit YAML document. Keep entry IDs and names aligned with the referenced kits.

Relative sources resolve against the catalog's location, not the shell's working directory. A local catalog at `/work/team/catalog.json` with `source: "kits/review.yaml"` refers to `/work/team/kits/review.yaml`. For a catalog fetched over HTTPS, the same source resolves relative to its URL. Local kit references must remain within the catalog directory after resolving symlinks. Remote kit references must remain within the catalog URL's directory and origin; cross-origin URLs and parent-directory escapes are rejected. Prefer relative sources. A source locates declarative data; it never names a command to run.

Each kit is self-contained. Its output text is inline YAML, not another set of source references. See [kit authoring](kits.md) for questions, conditions, interpolation, and outputs. Catalog registration and kit scope are application state; neither belongs in the catalog JSON or kit YAML.

Register an external catalog with:

```sh
loadout catalog add /path/to/catalog.json
```

External registrations are user-wide source references. They do not copy the source into a project or apply any kit. Repo is not registered through this command. Use organization-specific external catalog IDs and keep them stable.

## Missing sources and drift

Repo discovery and external registrations read live kit files, not imported copies. Installed kits retain their saved definition and answers so that a missing source, removed kit, invalid YAML, or temporary network failure does not uninstall or silently change existing files. One unavailable kit does not hide healthy kits from the same catalog.

Loadout reports changes between an installed snapshot and its current catalog definition. Updating is explicit: choose the catalog update, review compatible saved answers and any new questions, then use Review and Apply changes. Until then, the saved installation stays in effect. Source disappearance is a warning, not permission to delete installed files.

`loadout status` also reports modified, missing, unreadable, or unsafe managed output paths. Changes to user text **outside** managed instruction blocks are preserved and do not count as managed-content drift. Status inspection does not repair or overwrite files; output conflicts still block apply. Resolve those edits deliberately before retrying.

Drift compares current content to saved snapshots. It does not introduce catalog versions, revision histories, or automatic upgrades.

## Bundled content and attribution

The first-party `greenfield`, `no-em-dash`, `dont-commit`, `codex-cli`, `claude-cli`, `opencode-cli`, and `write-kit` kits are adapted from Loadout v1's `kits/loadout/` and `kits/loadout-agent-clis/` directories, copyright 2026 Loadout contributors, under the [MIT license](../LICENSE). The license is copied unchanged from v1.

The plain instruction kits preserve the original text. CLI kits retain the instructions-or-skill choice using v2 questions and inline outputs. Codex and Claude examples use the configured default model instead of retaining old hard-coded model names. `write-kit` is rewritten for the current declarative authoring format. `project-context` is a new example demonstrating all question types, conditional questions and outputs, content interpolation, a skill with supporting Markdown, and an optional file. No external kits are bundled.

Bundled instructions are data, not rules governing Loadout's development. In particular, `dont-commit` only contributes instructions when a user selects and applies that kit.
