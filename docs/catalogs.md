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

## Bundled content and attribution

The first-party `greenfield`, `no-em-dash`, `dont-commit`, `codex-cli`, `claude-cli`, `opencode-cli`, and `write-kit` kits are adapted from Loadout v1's `kits/loadout/` and `kits/loadout-agent-clis/` directories, copyright 2026 Loadout contributors, under the [MIT license](../LICENSE). The license is copied unchanged from v1.

The plain instruction kits preserve the original text. CLI kits retain the instructions-or-skill choice using v2 questions and inline outputs. Codex and Claude examples use the configured default model instead of retaining old hard-coded model names. `write-kit` is rewritten for the current declarative authoring format. `project-context` is a new example demonstrating all question types, conditional questions and outputs, content interpolation, a skill with supporting Markdown, and an optional file. No external kits are bundled.

Bundled instructions are data, not rules governing Loadout's development. In particular, `dont-commit` only contributes instructions when a user selects and applies that kit.
