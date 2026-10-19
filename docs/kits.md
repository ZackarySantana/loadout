# Authoring kits

A kit is one declarative YAML document. It asks questions and contributes instructions, skills, or files. All output contents are inline strings: no source scripts, shell hooks, arbitrary execution, or external output files. The strict schemas in [`src/domain/kit.ts`](../src/domain/kit.ts) are authoritative; unknown fields are rejected.

```yaml
id: project-note
name: Project note
description: Add a short project reminder.
questions:
  - id: project-name
    label: What is this project called?
    type: input
    default: My project
    required: true
outputs:
  - type: instructions
    targets: [AGENTS.md, CLAUDE.md]
    content: |
      You are working on {{project-name}}. Follow this repository's conventions.
```

Top-level fields are `id`, `name`, `description`, `questions`, and `outputs`. Require `id`, a nonempty `name`, and at least one output. `description` defaults to an empty string and `questions` to an empty array. IDs and skill names use lowercase letters, digits, and hyphens, starting with a letter or digit. Question IDs must be unique within a kit. Selection, scope, and saved answers live outside the kit.

## Questions

Questions are an ordered array, not a mapping. Every question has `id`, nonempty `label`, and `type`, with optional `description`, `default`, and `when`. All four types accept `description`, a short help string shown in gray italics after the controls. Use it to explain a non-obvious choice or consequence, not repeat the label. It is metadata only: it is not interpolated or included in generated output content.

| Type           | Answer / default                                       | Additional fields                                   |
| -------------- | ------------------------------------------------------ | --------------------------------------------------- |
| `input`        | String; absent default becomes empty text              | `required` is allowed only here, defaults to `true` |
| `boolean`      | Boolean; default `false`                               | None                                                |
| `select`       | One choice value; absent default uses the first choice | Required `choices`                                  |
| `multi-select` | Array of choice values; default `[]`                   | Required `choices`                                  |

`choices` is a nonempty array of `{value,label}` objects. Values are unique nonempty strings; labels are nonempty strings. A choice default must use the declared values, not their labels. Required text must contain non-whitespace characters. Set `required: false` for optional text, but do not put `required` on other types.

```yaml
questions:
  - id: deployment
    label: Include deployment guidance?
    type: boolean
    default: true
  - id: environment
    label: Which environment?
    description: Names the environment in the guidance; no deployment commands run.
    type: select
    when: { question: deployment, equals: true }
    default: staging
    choices:
      - { value: staging, label: Staging }
      - { value: production, label: Production }
  - id: checks
    label: Which checks?
    description: Choose any checks to include in the guidance; no checks run here.
    type: multi-select
    default: [tests]
    choices:
      - { value: tests, label: Run tests }
      - { value: rollback, label: Prepare rollback }
```

## Conditions and interpolation

Questions and outputs accept `when: {question, equals}` or `when: {question, includes}`, with exactly one operator. `equals` compares a string or boolean answer exactly; `includes` checks for a string in a multi-select answer. There is no expression language, nesting, or command evaluation. Quote string values such as `"true"` when they must not be YAML booleans.

A conditional question must refer only to an earlier question. An output condition may refer to any declared question. Hidden questions do not contribute answers; conditions on their missing answers do not match. Guard outputs that reference a conditional answer so they cannot interpolate an unanswered question.

Use `{{answer-id}}` to interpolate answers in **content only**: instruction `content`, skill `files` values, and file `content`. Strings remain strings, booleans become `true` or `false`, and multi-select arrays become comma-separated text. Unknown or unanswered references fail. Interpolation does not apply to paths, skill names, labels, choices, or other metadata. Never put placeholders in a file path or a skill file key.

## Outputs

All outputs require `type` and may have `when`.

### Instructions

```yaml
- type: instructions
  targets: [AGENTS.md, CLAUDE.md]
  content: |
    Review tests before changing deployment behavior.
  when: { question: checks, includes: tests }
```

`targets` is a nonempty array containing `AGENTS.md` and/or `CLAUDE.md`; omitted targets default to both. Repository instructions materialize in those files at the repository root. Global instructions materialize in `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md` respectively. Both targets receive their own instruction content, not an import directive.

### Skills

```yaml
- type: skill
  name: release-review
  files:
    SKILL.md: |
      ---
      name: release-review
      description: Review release readiness when asked to prepare a release.
      ---

      Read [the checklist](references/checklist.md) and report missing evidence.
    references/checklist.md: |
      Check tests, deployment approval, and recovery readiness.
```

`files` maps fixed relative paths to inline strings and must include `SKILL.md`. Give `SKILL.md` useful name/description frontmatter and link any supporting Markdown. A skill materializes in both `.agents/skills/<name>/` and `.claude/skills/<name>/`, beneath the repository root for repository scope or the home directory for global scope. Keep bundled skill files textual and declarative, without executable payloads.

### Other files

```yaml
- type: file
  path: docs/release-note.md
  content: |
    Review the selected checks: {{checks}}.
  when: { question: checks, includes: rollback }
```

A file output requires a fixed `path` and inline `content`. The path is relative to the selected scope root, repository or home directory. For file outputs and skill file keys, reject absolute paths, backslashes, empty segments, `.` segments, and `..` traversal. Do not interpolate paths. Add a boolean question and `when` to make a file opt-in.

File outputs must not target `.git` or `.loadout` path segments or the instruction destinations `AGENTS.md`, `CLAUDE.md`, `.codex/AGENTS.md`, and `.claude/CLAUDE.md`. Use an instructions output for those destinations. Avoid collisions between file and skill outputs.

## Complete example and review

[`project-context.yaml`](../catalog/kits/project-context.yaml) is a working starter demonstrating:

- `input` (`project-name`), `boolean` (`deployment-enabled`), `select` (`deployment-target`), and `multi-select` (`checks`).
- Conditional questions controlled by an earlier boolean.
- Conditional outputs using both `equals` and `includes`.
- Content interpolation in instructions, skill files, and an optional deployment note.
- Instructions for both agents, a skill with supporting Markdown, and the opt-in `docs/deployment-context.md` file.

Try deployment disabled, deployment enabled with and without rollback, and the optional note enabled. Hidden answers must never be required by active output text. Check every choice and default, preview generated content, and apply only after reviewing the planned changes. Scope is selected in Loadout, not declared in YAML. For `both`, global presence suppresses repository copies while preserving repository intent.

Add your kit to a [catalog](catalogs.md) with `{id,name,description,source}` pointing to its YAML file. Edit the kit source rather than generated instructions or skill copies. Attribution for the bundled first-party adaptations is documented in [Catalogs](catalogs.md#bundled-content-and-attribution).
