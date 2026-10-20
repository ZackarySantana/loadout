# Historical context-comparison evidence

These are documentation fixtures retrieved on **19 October 2026**, not runtime catalog templates. The Matt Pocock, Anthropic, and Ponytail source bytes, licenses, original Loadout `SOURCE.md` packaging notices, optional Codex metadata, and Ponytail `AGENTS.md` comparison are preserved unchanged from the original comparison. Their historical commit pins make that comparison reproducible; live remote catalogs may have changed.

`SOURCE.md` describes the original curated snapshot packaging. It does not mean these files are currently installed or offered as built-in Loadout kits. In `external-sources.json`, `installedPath` is the former package-relative path, not a current installation destination. Original `external-*` record IDs identify the historical fixtures, not aliases for remote catalog selections.

## Regenerate measurements offline

From the checkout root, using the existing local dependencies:

```sh
mise exec -- bun scripts/measure-context.ts
```

This first-party tool reads only these historical fixtures and writes:

- `site/evidence/external-sources.json`: full measurements, provenance, license references, and per-file SHA-256 values.
- `site/source-measurements.json`: downloadable presentation extract and assumed activation arithmetic.

It never fetches upstream content, executes upstream scripts, changes source/license/notice bytes, or generates runtime kit YAML. Review the generated JSON against `site/index.html` tables, totals, activation cases, methodology, citations, and retrieval-date prose; HTML is not regenerated. Do not replace fixtures with live upstream content as part of a catalog update.

The figures measure UTF-8 bytes, Unicode code points, whitespace-separated words, and lines—not tokens or observed runtime savings. The Ponytail `AGENTS.md` is different real text, not an equivalent-content savings baseline. Full methodology and loading assumptions are in the JSON and [documentation](../index.html#context).

The MIT and Apache-2.0 notices accompanying these fixtures remain applicable. The comparison file has its own preserved MIT license. Public repository access alone does not establish redistribution rights for other upstream skills. Historical evidence pins have no role in runtime update equality, which uses file-content hashes rather than commits or dates.
