---
name: loadout-write-kit
description: Create or edit Loadout kits in .loadout/kits/.
---

Adapt this example; drop unused questions, outputs, and files.

`.loadout/kits/review/kit.yaml`:

```yaml
schemaVersion: 1
id: review
description: Review changes
questions:
  diagrams: { type: boolean, message: Include diagrams?, default: false }
  detail: { type: choice, message: Review depth?, choices: [brief, detailed], default: brief }
outputs:
  - type: skill
    source: skills/review
  - type: instructions
    source: instructions.md
  - type: instructions
    source: diagrams.md
    scope: src
    when: { answer: diagrams, equals: true }
  - type: instructions
    source: detailed.md
    when: { answer: detail, equals: detailed }
```

`.loadout/kits/review/skills/review/SKILL.md`:

```markdown
---
name: review
description: Review this repository's code changes.
---

Read the diff, then report defects with file, line, and a suggested fix.
```

- Use unique lowercase-hyphen IDs; question keys and skill names use the same format. Skill `name` matches its directory.
- Sources are relative to `kit.yaml`; create every referenced file/directory, including conditional ones. No traversal, globs, or symlinks. Edit sources, not generated files.
- `ready: false` blocks selection (**Needs setup**); omitted/true is ready; ready kits need at least one output. No `enabled` field: selection is personal state.
- Add `requires: [checks]` for an existing ready kit; no cycles. Shared/explicit dependencies survive dependent removal; `loadout disable checks --cascade` also removes selected dependents.
- Answers reuse saved values, then optional defaults; otherwise input is required. `when` matches one same-kit answer on either output type. No conditional questions or interpolation.
- Instructions create `AGENTS.md` + a `CLAUDE.md` import at `scope` (default `.`). Other scopes require existing repository directories; global allows only `.`. Skills have no scope.
- Skills copy to both agents with references, scripts, assets, binaries, and executable bits; scripts aren't run on install. Link supporting files from `SKILL.md`.

```sh
loadout enable review --answer review.diagrams=true --answer review.detail=detailed --dry-run --diff
loadout disable review
```

Drop `--dry-run --diff` to apply, or select via `loadout` → Kits → Continue.