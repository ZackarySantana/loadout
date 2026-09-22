# Publishing and subscribing to catalogs

A catalog is a versioned YAML or JSON manifest served at an HTTPS URL. A raw GitHub URL works. HTTP is supported on localhost for development.

## Configuration scopes

Add catalog URLs to `config.yaml`:

```yaml
schemaVersion: 1
catalogs:
  - https://raw.githubusercontent.com/acme/agent-kits/main/catalog.yaml
```

| File                                   | Availability                                  |
| -------------------------------------- | --------------------------------------------- |
| `~/.loadout/config.yaml`               | All your repositories and Global              |
| `~/.loadout-personal/config.yaml`      | All your repositories and Global              |
| `<repo>/.loadout/config.yaml`          | Everyone using this repository when committed |
| `<repo>/.loadout-personal/config.yaml` | Your private choices in this repository       |

The CLI uses `.loadout/config.yaml` by default, the home configuration with `--personal` or `--global`, and the repository's `.loadout-personal/config.yaml` with `--private`. Selections and answers stay in each destination's own `.loadout-personal/local.json`.

Set `curated: false` to disable the default official subscription. The nearest explicitly configured `curated` value wins; merely adding a repository subscription does not override a personal setting. Local kits and inline `externalKits` remain supported.

## A catalog of upstream skills

```yaml
schemaVersion: 1
id: acme
name: Acme engineering
description: Shared engineering workflows
providers:
  - id: acme
    description: Acme's review workflows
    prefix: acme-
    kits:
      - id: acme-review
        description: Review changes using our engineering conventions
        source:
          repo: acme/agent-kits
          integrity: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
          skills:
            - skills/review
          license: LICENSE
```

Replace the example hash using `loadout catalog hash catalog.yaml`. The hash versions the kit's contents, not its repository. Sources follow the repository's default branch (`HEAD`) unless an optional `ref` names another branch or tag. That ref is only a download locator: unrelated repository changes do not create kit updates. Loadout verifies the downloaded content against the kit hash and preserves the installed snapshot until an explicit kit update is selected.

`catalog hash` downloads and validates each kit, computes its content hash, and writes the manifest only after every kit succeeds. Use `--ref HEAD` to move older commit-based entries to default-branch locators. Legacy entries with full commit SHAs and no content hash remain readable.

Each provider supplies its display ID, description, optional prefix, and kits. Prefixes are removed from kit names inside that provider's Browse view. A single catalog can offer multiple providers and source repositories.

If a source folder differs from its skill's frontmatter name, declare a mapping:

```yaml
skills: [skills/review]
skillNames:
  skills/review: acme-review
```

All skill resources are preserved, and the declared upstream license is retained as `LICENSE.upstream`.

## Complete Loadout kits

For instructions, questions, conditional outputs, and dependencies, use `source.kit` instead of `source.skills`:

```yaml
id: acme-guidance
description: Choose how to install Acme guidance
source:
  repo: acme/agent-kits
  integrity: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  license: LICENSE
  kit:
    path: kits/guidance
    manifest:
      schemaVersion: 1
      id: acme-guidance
      description: Choose how to install Acme guidance
      questions:
        placement:
          type: choice
          message: Install as context or a skill?
          choices: [context, skill]
      outputs:
        - type: instructions
          source: instructions.md
          when: { answer: placement, equals: context }
        - type: skill
          source: skills/acme-guidance
          when: { answer: placement, equals: skill }
```

`manifest` uses the existing `kit.yaml` format and is authoritative for the published kit. Copy the kit definition here when publishing, including its questions, dependencies, and outputs. Its ID must match the catalog entry. Output paths are relative to `source.kit.path`. The files in that directory are downloaded only when the kit is selected; the catalog already contains the metadata needed to browse, resolve dependencies, and ask questions.

The kit hash is SHA-256 over canonical JSON containing the complete-kit manifest (when present) and sorted `[installed-relative-path, Git-blob-SHA, mode]` file entries, including the upstream license. Downloaded bytes are checked against the Git blob hashes before the overall kit hash is checked. This covers file additions, removals, renames, executable modes, and question/output changes without including the repository's commit identity.

Dependencies name other kit IDs available in the combined catalogs. Use globally distinctive kit IDs, such as an organization prefix. A repeated subscription URL is deduplicated; conflicting kit IDs are errors. A catalog's stable `id` must not change at its URL, and distinct URLs claiming the same catalog ID are rejected. Installed catalog ownership is checked before accepting a replacement definition.

## Refreshing, offline use, and removal

- `loadout catalog refresh` updates manifests, not installed kit content.
- `loadout outdated` compares installed sources against cached catalog offers without network requests.
- `loadout update --dry-run` previews explicitly updating installed sources.
- Normal online browsing refreshes manifests older than one hour. An unavailable or invalid response keeps the last valid manifest and reports the problem.
- `--offline` never fetches manifests or kit content. Uncached catalogs are unavailable until an online run; local and saved installed kits still work.
- Removing a subscription removes its offerings from Browse. Installed kits and their dependencies remain in Installed using their saved definitions and snapshots, and can still be configured or disabled offline.
- Downloads cached during a preview do not install agent outputs or save selections.

Manifest and reusable complete-kit caches live in `~/.cache/loadout/`. Set `LOADOUT_CACHE_DIR` to relocate this disposable cache. Installed snapshots remain in the destination's `.loadout-personal/external.json`, so removing the shared cache does not remove installed kits.

## The official catalog

Loadout's default URL is `https://raw.githubusercontent.com/ZackarySantana/loadout/main/catalog.yaml`. It follows the same schema and subscription flow as other catalogs. The source manifest and kit authoring files remain in the repository but are excluded from the npm package.

Publish `catalog.yaml` at that URL before releasing a CLI version that depends on it. Publish changed kit files first, run `loadout catalog hash catalog.yaml`, then publish the updated manifest. Existing installations keep working from their saved snapshots during this transition; downloads with a stale manifest report a content-hash mismatch instead of installing unverified changes.
