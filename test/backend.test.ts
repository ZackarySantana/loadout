import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as filesystem from "node:fs/promises"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { stringify } from "yaml"
import { LoadoutService } from "../src/backend/service"
import {
  kitSchema,
  type Answers,
  type LoadedKit,
  type Scope,
} from "../src/domain/kit"

const fixtures: string[] = []

afterEach(async () => {
  for (const directory of fixtures.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp("/tmp/opencode/loadout-backend-")
  fixtures.push(root)
  const home = join(root, "home")
  const repository = join(root, "repo-a")
  const otherRepository = join(root, "repo-b")
  await Promise.all(
    [home, repository, otherRepository].map((path) => mkdir(path)),
  )
  const open = (repo = repository) =>
    LoadoutService.open({ home, repository: repo, environment: {} })
  return {
    root,
    home,
    repository,
    otherRepository,
    open,
    service: await open(),
  }
}

async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function text(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else result[path.slice(root.length)] = await readFile(path, "utf8")
    }
  }
  await walk(root)
  return result
}

function simpleKit(id = "guide"): LoadedKit {
  return {
    key: `team/${id}`,
    kit: kitSchema.parse({
      id,
      name: id,
      questions: [{ id: "project", label: "Project", type: "input" }],
      outputs: [
        { type: "instructions", content: "Work on {{project}}." },
        { type: "file", path: `context/${id}.txt`, content: "{{project}}\n" },
      ],
    }),
  }
}

async function configure(
  service: LoadoutService,
  item: LoadedKit,
  scope: Scope,
  answers: Answers = {},
) {
  await service.apply(await service.plan([{ item, scope, answers }]))
}

async function catalogFixture(
  directory: string,
  kit = simpleKit().kit,
  extra: Record<string, unknown> = {},
) {
  const source = join(directory, "catalog.json")
  await put(join(directory, "guide.yaml"), stringify(kit))
  await put(
    source,
    JSON.stringify({
      id: "team",
      name: "Team",
      kits: [{ id: kit.id, name: kit.name, source: "guide.yaml" }],
      ...extra,
    }),
  )
  return source
}

describe("backend integration flows", () => {
  test("declarative answers render instructions, skills and files, and reconfiguration removes conditional output", async () => {
    const { service, repository, open } = await fixture()
    const item: LoadedKit = {
      key: "team/workflow",
      kit: kitSchema.parse({
        id: "workflow",
        name: "Workflow",
        questions: [
          { id: "project", label: "Project", type: "input" },
          { id: "enabled", label: "Enable details", type: "boolean" },
          {
            id: "language",
            label: "Language",
            type: "select",
            choices: [
              { value: "ts", label: "TypeScript" },
              { value: "rs", label: "Rust" },
            ],
          },
          {
            id: "checks",
            label: "Checks",
            type: "multi-select",
            choices: [
              { value: "lint", label: "Lint" },
              { value: "test", label: "Test" },
            ],
          },
          {
            id: "detail",
            label: "Detail",
            type: "input",
            when: { question: "enabled", equals: true },
          },
          {
            id: "runner",
            label: "Runner",
            type: "input",
            when: { question: "checks", includes: "test" },
          },
        ],
        outputs: [
          {
            type: "instructions",
            content: "{{ project }} / {{language}} / {{checks}} / {{enabled}}",
          },
          {
            type: "skill",
            name: "workflow",
            files: {
              "SKILL.md": "# {{project}}",
              "references/checks.md": "Run {{runner}}: {{checks}}",
            },
            when: { question: "checks", includes: "test" },
          },
          {
            type: "file",
            path: "context/detail.txt",
            content: "{{detail}}",
            when: { question: "enabled", equals: true },
          },
          {
            type: "file",
            path: "context/rust.txt",
            content: "{{language}}",
            when: { question: "language", equals: "rs" },
          },
        ],
      }),
    }
    const answers = {
      project: "Atlas",
      enabled: true,
      language: "ts",
      checks: ["lint", "test"],
      detail: "Be precise",
      runner: "bun test",
    }
    await configure(service, item, "repository", answers)
    for (const target of ["AGENTS.md", "CLAUDE.md"]) {
      expect(await text(join(repository, target))).toContain(
        "Atlas / ts / lint, test / true",
      )
    }
    for (const agent of [".agents", ".claude"]) {
      expect(
        await text(join(repository, agent, "skills/workflow/SKILL.md")),
      ).toBe("# Atlas")
      expect(
        await text(
          join(repository, agent, "skills/workflow/references/checks.md"),
        ),
      ).toBe("Run bun test: lint, test")
    }
    expect(await text(join(repository, "context/detail.txt"))).toBe(
      "Be precise",
    )
    expect(await text(join(repository, "context/rust.txt"))).toBeNull()
    expect((await open()).configuration(item.key)).toEqual({
      scope: "repository",
      answers,
    })

    await configure(service, item, "repository", {
      project: "Nova",
      enabled: false,
      language: "rs",
      checks: [],
      detail: "ignored",
      runner: "ignored",
    })
    expect((await open()).configuration(item.key).answers).toEqual({
      project: "Nova",
      enabled: false,
      language: "rs",
      checks: [],
    })
    expect(await text(join(repository, "AGENTS.md"))).toContain(
      "Nova / rs /  / false",
    )
    expect(await text(join(repository, "context/rust.txt"))).toBe("rs")
    expect(await text(join(repository, "context/detail.txt"))).toBeNull()
    for (const agent of [".agents", ".claude"])
      expect(
        await text(join(repository, agent, "skills/workflow/SKILL.md")),
      ).toBeNull()
    await expect(
      service.plan([
        {
          item,
          scope: "repository",
          answers: {
            project: "Nova",
            enabled: false,
            language: "invalid",
            checks: [],
          },
        },
      ]),
    ).rejects.toThrow(/available options/)
  })

  test("global and both suppress known repositories and restore each repository's persisted answers across sessions", async () => {
    const { service, home, repository, otherRepository, open } = await fixture()
    const item = simpleKit()
    await configure(service, item, "repository", { project: "Alpha" })
    await configure(await open(otherRepository), item, "repository", {
      project: "Beta",
    })
    const liveOtherSession = await open(otherRepository)
    await configure(await open(), item, "both", { project: "Shared" })
    expect(await text(join(home, "context/guide.txt"))).toBe("Shared\n")
    expect(await text(join(home, ".codex/AGENTS.md"))).toContain(
      "Work on Shared.",
    )
    expect(await text(join(home, ".claude/CLAUDE.md"))).toContain(
      "Work on Shared.",
    )
    for (const repo of [repository, otherRepository]) {
      expect(await text(join(repo, "context/guide.txt"))).toBeNull()
      expect(await text(join(repo, "AGENTS.md"))).toBeNull()
    }
    expect((await open()).configuration(item.key)).toEqual({
      scope: "both",
      answers: { project: "Shared" },
    })
    expect((await open(otherRepository)).configuration(item.key).scope).toBe(
      "both",
    )
    expect(
      (await open(otherRepository)).installed().map((kit) => kit.key),
    ).toEqual([item.key])

    // Drop only global intent while retaining the first repository's intent.
    await configure(await open(), item, "repository", {
      project: "Alpha restored",
    })
    expect(await text(join(home, "context/guide.txt"))).toBeNull()
    expect(await text(join(repository, "context/guide.txt"))).toBe(
      "Alpha restored\n",
    )
    expect(await text(join(otherRepository, "context/guide.txt"))).toBe(
      "Beta\n",
    )
    expect((await open(otherRepository)).configuration(item.key)).toEqual({
      scope: "repository",
      answers: { project: "Beta" },
    })

    // Global-only installation must not silently grant repository intent to A.
    // The same key can now have a different global question/definition from B's saved kit.
    const globalItem: LoadedKit = {
      key: item.key,
      kit: kitSchema.parse({
        id: item.kit.id,
        name: "Organization guide",
        questions: [{ id: "audience", label: "Audience", type: "input" }],
        outputs: [
          { type: "instructions", content: "Shared rules for {{audience}}." },
          {
            type: "file",
            path: "context/guide.txt",
            content: "{{audience}}\n",
          },
        ],
      }),
    }
    await configure(await open(), globalItem, "global", {
      audience: "Organization",
    })
    await service.refresh()
    await liveOtherSession.refresh()
    expect(service.configuration(item.key)).toEqual({
      scope: "global",
      answers: { audience: "Organization" },
    })
    expect(liveOtherSession.configuration(item.key)).toEqual({
      scope: "both",
      answers: { audience: "Organization" },
    })
    expect(service.installed()).toEqual([globalItem])
    expect(liveOtherSession.installed()).toEqual([globalItem])
    expect(await text(join(home, "context/guide.txt"))).toBe("Organization\n")
    expect(await text(join(home, ".codex/AGENTS.md"))).toContain(
      "Shared rules for Organization.",
    )
    expect(await text(join(otherRepository, "context/guide.txt"))).toBeNull()
    await configure(await open(), globalItem, "none")
    await service.refresh()
    await liveOtherSession.refresh()
    expect(service.configuration(item.key).scope).toBe("none")
    expect(service.installed()).toEqual([])
    expect(liveOtherSession.configuration(item.key)).toEqual({
      scope: "repository",
      answers: { project: "Beta" },
    })
    expect(liveOtherSession.installed()).toEqual([item])
    expect(await text(join(repository, "context/guide.txt"))).toBeNull()
    expect(await text(join(otherRepository, "context/guide.txt"))).toBe(
      "Beta\n",
    )
  })

  test("user instructions and other kits survive updating and removing one kit", async () => {
    const { service, repository, open } = await fixture()
    const first = simpleKit("first")
    const second = simpleKit("second")
    for (const target of ["AGENTS.md", "CLAUDE.md"])
      await put(join(repository, target), "# User rules\nKeep these rules.\n")
    await service.apply(
      await service.plan([
        { item: first, scope: "repository", answers: { project: "First" } },
        { item: second, scope: "repository", answers: { project: "Second" } },
      ]),
    )
    for (const target of ["AGENTS.md", "CLAUDE.md"]) {
      const path = join(repository, target)
      await put(path, `${await text(path)}\nUser added a footer.\n`)
    }
    await configure(await open(), first, "repository", { project: "Updated" })
    await configure(await open(), first, "none")
    for (const target of ["AGENTS.md", "CLAUDE.md"]) {
      const content = await text(join(repository, target))
      expect(content).toContain("# User rules\nKeep these rules.\n")
      expect(content).toContain("User added a footer.")
      expect(content).toContain("Work on Second.")
      expect(content).not.toContain("loadout:team/first")
    }
    expect(await text(join(repository, "context/first.txt"))).toBeNull()
    expect(await text(join(repository, "context/second.txt"))).toBe("Second\n")
    await configure(await open(), second, "none")
    expect(await text(join(repository, "AGENTS.md"))).toContain(
      "User added a footer.",
    )
    expect((await open()).installed()).toEqual([])

    // Pre-existing empty/whitespace files must remain files, and inserted separators
    // must not change a user's final newline (or lack of one) after removal.
    for (const original of [
      "",
      " \t\r\n\n",
      "# User rules without a final newline",
    ]) {
      for (const target of ["AGENTS.md", "CLAUDE.md"])
        await put(join(repository, target), original)
      await configure(await open(), first, "repository", {
        project: "Installed",
      })
      await configure(await open(), first, "repository", { project: "Updated" })
      for (const target of ["AGENTS.md", "CLAUDE.md"]) {
        expect(await text(join(repository, target))).toContain(
          "Work on Updated.",
        )
      }
      await configure(await open(), first, "none")
      for (const target of ["AGENTS.md", "CLAUDE.md"]) {
        expect(await readFile(join(repository, target))).toEqual(
          Buffer.from(original),
        )
      }
    }
  })

  test("unmanaged collisions and edits to managed files or instruction blocks refuse the entire change", async () => {
    const { service, root, repository, open } = await fixture()
    const item = simpleKit()
    const file = join(repository, "context/guide.txt")
    await put(file, "User-owned context\n")
    const beforeCollision = await snapshot(root)
    await expect(
      service.plan([
        { item, scope: "repository", answers: { project: "Atlas" } },
      ]),
    ).rejects.toThrow(/unmanaged file/)
    expect(await snapshot(root)).toEqual(beforeCollision)
    await rm(file)
    await configure(service, item, "repository", { project: "Atlas" })
    await put(file, "Locally edited\n")
    const beforeEdit = await snapshot(root)
    await expect(
      (await open()).plan([{ item, scope: "none", answers: {} }]),
    ).rejects.toThrow(/Managed file was edited/)
    expect(await snapshot(root)).toEqual(beforeEdit)
    await put(file, "Atlas\n")
    const instructions = join(repository, "AGENTS.md")
    await put(
      instructions,
      (await text(instructions))!.replace(
        "Work on Atlas.",
        "My edited managed rule.",
      ),
    )
    const beforeBlockEdit = await snapshot(root)
    await expect(
      (await open()).plan([
        { item, scope: "repository", answers: { project: "Updated" } },
      ]),
    ).rejects.toThrow(/Managed instructions were edited/)
    expect(await snapshot(root)).toEqual(beforeBlockEdit)
  })

  test("review is write-free, file edits invalidate apply, and a fresh review preserves those edits", async () => {
    const { service, root, repository, open } = await fixture()
    const item = simpleKit()
    const instructions = join(repository, "AGENTS.md")
    await put(instructions, "User rules\n")
    const before = await snapshot(root)
    const plan = await service.plan([
      { item, scope: "repository", answers: { project: "Atlas" } },
    ])
    expect(
      plan.changes.find((change) => change.path === instructions),
    ).toMatchObject({ before: "User rules\n" })
    expect(plan.changes.map((change) => change.path).sort()).toEqual(
      [
        instructions,
        join(repository, "CLAUDE.md"),
        join(repository, "context/guide.txt"),
      ].sort(),
    )
    expect(await snapshot(root)).toEqual(before)
    expect(service.configuration(item.key).scope).toBe("none")
    await put(instructions, "User rules changed during review\n")
    const edited = await snapshot(root)
    await expect(service.apply(plan)).rejects.toThrow(
      /File changed since review/,
    )
    expect(await snapshot(root)).toEqual(edited)
    expect((await open()).configuration(item.key).scope).toBe("none")
    const fresh = await service.plan([
      { item, scope: "repository", answers: { project: "Atlas" } },
    ])
    await service.apply(fresh)
    expect(await text(instructions)).toContain(
      "User rules changed during review\n",
    )
    expect(await text(instructions)).toContain("Work on Atlas.")
    await expect(service.apply(fresh)).rejects.toThrow(/fresh plan/)
  })

  test("review snapshots caller-owned selections before awaiting and ignores edits to exposed changes when applying", async () => {
    const { service, repository, open } = await fixture()
    const item = simpleKit()
    item.kit.questions.push({
      id: "checks",
      label: "Checks",
      type: "multi-select",
      choices: [
        { value: "lint", label: "Lint" },
        { value: "test", label: "Test" },
      ],
      default: [],
    })
    item.kit.outputs.push({
      type: "file",
      path: "context/checks.txt",
      content: "{{checks}}",
    })
    const answers = { project: "Reviewed", checks: ["lint"] }
    const intendedItem = structuredClone(item)
    const intendedAnswers = structuredClone(answers)
    const reviewing = service.plan([{ item, scope: "repository", answers }])
    // Deliberately do not await plan before changing the caller's nested objects.
    answers.project = "Unreviewed"
    answers.checks.push("test")
    item.kit.name = "Unreviewed name"
    item.kit.questions.splice(0)
    item.kit.outputs.splice(0, item.kit.outputs.length, {
      type: "file",
      path: "context/unreviewed.txt",
      content: "Unreviewed output",
    })
    const plan = await reviewing
    expect(
      plan.changes.find(
        (change) => change.path === join(repository, "context/guide.txt"),
      )?.after,
    ).toBe("Reviewed\n")
    expect(
      plan.changes.find(
        (change) => change.path === join(repository, "context/checks.txt"),
      )?.after,
    ).toBe("lint")
    // The review is public display data, not the authoritative transaction.
    for (const change of plan.changes) {
      change.path = join(repository, "context/tampered.txt")
      change.before = "Invented previous content"
      change.after = "Tampered review"
    }
    plan.summary.splice(0, plan.summary.length, "Tampered summary")
    await service.apply(plan)
    expect(await text(join(repository, "context/guide.txt"))).toBe("Reviewed\n")
    expect(await text(join(repository, "context/checks.txt"))).toBe("lint")
    for (const target of ["AGENTS.md", "CLAUDE.md"])
      expect(await text(join(repository, target))).toContain(
        "Work on Reviewed.",
      )
    expect(await text(join(repository, "context/tampered.txt"))).toBeNull()
    expect(await text(join(repository, "context/unreviewed.txt"))).toBeNull()
    const reopened = await open()
    expect(reopened.installed()).toEqual([intendedItem])
    expect(reopened.configuration(intendedItem.key)).toEqual({
      scope: "repository",
      answers: intendedAnswers,
    })
    // The persisted snapshot must also be usable for the next real user operation.
    await configure(reopened, reopened.installed()[0]!, "none")
    expect(await text(join(repository, "context/checks.txt"))).toBeNull()
    expect(await text(join(repository, "AGENTS.md"))).toBeNull()
  })

  test("a competing session invalidates a reviewed plan without losing either session's selections", async () => {
    const { service, root, repository, open } = await fixture()
    const first = simpleKit("first")
    const second = simpleKit("second")
    const stale = await service.plan([
      { item: first, scope: "repository", answers: { project: "First" } },
    ])
    await configure(await open(), second, "repository", { project: "Second" })
    const committed = await snapshot(root)
    await expect(service.apply(stale)).rejects.toThrow(/another session/)
    expect(await snapshot(root)).toEqual(committed)
    await configure(service, first, "repository", { project: "First" })
    const reopened = await open()
    expect(
      reopened
        .installed()
        .map((item) => item.key)
        .sort(),
    ).toEqual([first.key, second.key])
    expect(await text(join(repository, "AGENTS.md"))).toContain(
      "Work on First.",
    )
    expect(await text(join(repository, "AGENTS.md"))).toContain(
      "Work on Second.",
    )
  })

  test("symlinked output components, traversal and reserved paths cannot write outside managed destinations", async () => {
    const { service, root, repository } = await fixture()
    const outside = join(root, "outside")
    await mkdir(outside)
    await put(join(outside, "guide.txt"), "Do not touch\n")
    await symlink(outside, join(repository, "context"))
    await expect(
      service.plan([
        {
          item: simpleKit(),
          scope: "repository",
          answers: { project: "Atlas" },
        },
      ]),
    ).rejects.toThrow(/symlink/)
    expect(await text(join(outside, "guide.txt"))).toBe("Do not touch\n")
    await rm(join(repository, "context"))
    const before = await snapshot(root)
    for (const path of [
      "../escaped.txt",
      "/tmp/opencode/escaped.txt",
      "context/../../escaped.txt",
    ]) {
      await expect(
        (async () => {
          const kit = kitSchema.parse({
            id: "unsafe",
            name: "Unsafe",
            outputs: [{ type: "file", path, content: "bad" }],
          })
          await service.plan([
            {
              item: { key: "team/unsafe", kit },
              scope: "repository",
              answers: {},
            },
          ])
        })(),
      ).rejects.toThrow(/relative path/)
    }
    for (const path of [".git/config", ".loadout/state.json", "AGENTS.md"]) {
      const kit = kitSchema.parse({
        id: "unsafe",
        name: "Unsafe",
        outputs: [{ type: "file", path, content: "bad" }],
      })
      await expect(
        service.plan([
          {
            item: { key: "team/unsafe", kit },
            scope: "repository",
            answers: {},
          },
        ]),
      ).rejects.toThrow(/Reserved output path/)
    }
    expect(await snapshot(root)).toEqual(before)

    // A link substituted after review is rejected again at apply time.
    const plan = await service.plan([
      { item: simpleKit(), scope: "repository", answers: { project: "Atlas" } },
    ])
    await symlink(outside, join(repository, "context"))
    await expect(service.apply(plan)).rejects.toThrow(/symlink/)
    expect(await text(join(outside, "guide.txt"))).toBe("Do not touch\n")
    expect(await text(join(repository, "AGENTS.md"))).toBeNull()
  })

  test("catalog registration loads YAML kits, persists across sessions and leaves the permanent built-in catalog available", async () => {
    const { service, root, repository, open } = await fixture()
    const initial = await service.catalogs()
    expect(initial.errors).toEqual([])
    const builtin = initial.catalogs.find(
      (catalog) => catalog.id === "loadout",
    )!
    expect(builtin.permanent).toBe(true)
    expect(builtin.kits.length).toBeGreaterThan(0)
    const source = await catalogFixture(join(repository, "catalog"))
    const registered = await service.register("catalog/catalog.json")
    expect(registered.source).toBe(source)
    expect(registered.permanent).toBe(false)
    expect(registered.kits.map((item) => item.key)).toEqual(["team/guide"])
    await expect(service.register(source)).rejects.toThrow(/already registered/)
    const reopened = await open()
    expect(
      (await reopened.catalogs()).catalogs.map((catalog) => catalog.name),
    ).toEqual(["Repo", "Loadout", "Team"])
    await configure(reopened, registered.kits[0]!, "repository", {
      project: "From catalog",
    })
    expect(await text(join(repository, "context/guide.txt"))).toBe(
      "From catalog\n",
    )
    await reopened.unregister(source)
    const after = await open()
    expect(
      (await after.catalogs()).catalogs.map((catalog) => catalog.name),
    ).toEqual(["Repo", "Loadout"])
    expect(after.configuration("team/guide").scope).toBe("repository")
    const before = await snapshot(root)
    await expect(after.unregister(builtin.source)).rejects.toThrow(/permanent/)
    expect(await snapshot(root)).toEqual(before)
  })

  test("catalog formats stay strict while invalid or escaping kit sources are quarantined without hiding healthy siblings or discarding installed snapshots", async () => {
    const { service, root, repository, open } = await fixture()
    const directory = join(repository, "catalog")
    const source = await catalogFixture(directory)
    const document = JSON.parse((await text(source))!)
    document.kits.push({
      id: "healthy",
      name: "Healthy",
      source: "healthy.yaml",
    })
    const validCatalog = JSON.stringify(document)
    const validKit = (await text(join(directory, "guide.yaml")))!
    await put(
      join(directory, "healthy.yaml"),
      stringify(simpleKit("healthy").kit),
    )
    const outsideKit = join(repository, "outside.yaml")
    await put(outsideKit, validKit)
    const before = await text(join(root, "home/.loadout/state.json"))
    for (const invalidCatalog of [
      "id: team\nname: Not JSON\nkits: []\n",
      "{broken JSON",
      JSON.stringify({ ...document, unexpected: true }),
      JSON.stringify({ ...document, kits: "not an array" }),
    ]) {
      await put(source, invalidCatalog)
      await expect(service.register(source)).rejects.toThrow()
      expect(await text(join(root, "home/.loadout/state.json"))).toBe(before)
    }

    const staleItem: LoadedKit = {
      ...simpleKit(),
      origin: { source, scope: "global", catalogId: "team" },
    }
    const invalidKits = [
      { yaml: "id: guide\noutputs: [\n", reason: /flow|expected|stream/i },
      { yaml: `${validKit}\nexecute: shell\n`, reason: /unrecognized/i },
      { yaml: `${validKit}\nid: duplicate\n`, reason: /unique|duplicate/i },
      {
        yaml: validKit.replace("id: guide", "id: other"),
        reason: /ID mismatch/,
      },
      {
        yaml: validKit,
        reference: "../outside.yaml",
        reason: /catalog directory/,
      },
      { yaml: validKit, link: true, reason: /catalog directory/ },
    ]
    for (const invalid of invalidKits) {
      await rm(join(directory, "guide.yaml"))
      if (invalid.link) await symlink(outsideKit, join(directory, "guide.yaml"))
      else await put(join(directory, "guide.yaml"), invalid.yaml)
      const changedDocument = structuredClone(document)
      changedDocument.kits[0].source = invalid.reference ?? "guide.yaml"
      await put(source, JSON.stringify(changedDocument))
      // Reject escaped assets before reading them, not after parsing their valid YAML.
      const reads = spyOn(filesystem, "readFile")
      try {
        const registered = await service.register(source)
        expect(registered.kits.map((item) => item.key)).toEqual([
          "team/healthy",
        ])
        expect(
          registered.unavailableKits?.find((item) => item.key === "team/guide")
            ?.reason,
        ).toMatch(invalid.reason)
        const listing = await service.catalogs()
        expect(listing.errors.join("\n")).toContain("team/guide")
        expect(
          listing.catalogs
            .find((catalog) => catalog.id === "team")
            ?.kits.map((item) => item.key),
        ).toEqual(["team/healthy"])
        if (invalid.reference || invalid.link) {
          const pathsRead = reads.mock.calls.map(([path]) => String(path))
          expect(pathsRead).toContain(join(directory, "healthy.yaml"))
          expect(pathsRead).not.toContain(outsideKit)
          if (invalid.link)
            expect(pathsRead).not.toContain(join(directory, "guide.yaml"))
        }
        expect(service.installed().map((item) => item.key)).not.toContain(
          "team/guide",
        )
        const beforeAttempt = await snapshot(root)
        await expect(
          service.plan([
            {
              item: staleItem,
              scope: "repository",
              answers: { project: "Unsafe" },
            },
          ]),
        ).rejects.toThrow(/source changed or is unavailable/)
        expect(await snapshot(root)).toEqual(beforeAttempt)
        await configure(service, registered.kits[0]!, "repository", {
          project: "Healthy",
        })
        expect(await text(join(repository, "context/healthy.txt"))).toBe(
          "Healthy\n",
        )
        expect(await text(join(repository, "context/guide.txt"))).toBeNull()
      } finally {
        reads.mockRestore()
      }
      await service.unregister(source)
    }

    await rm(join(directory, "guide.yaml"))
    await put(join(directory, "guide.yaml"), validKit)
    await put(source, validCatalog)
    const restored = await service.register(source)
    await configure(
      service,
      restored.kits.find((item) => item.key === "team/guide")!,
      "repository",
      { project: "Saved" },
    )
    const savedGuide = service
      .installed()
      .find((item) => item.key === "team/guide")!
    await put(join(directory, "guide.yaml"), "not: a valid kit\n")
    const reopened = await open()
    const loaded = await reopened.status()
    expect(
      loaded.catalogs
        .find((catalog) => catalog.id === "team")
        ?.kits.map((item) => item.key),
    ).toEqual(["team/healthy"])
    expect(
      loaded.catalogs
        .find((catalog) => catalog.id === "team")
        ?.unavailableKits?.find((item) => item.key === "team/guide"),
    ).toBeDefined()
    expect(loaded.errors.join("\n")).toContain(source)
    expect(
      loaded.drift.kits.find((item) => item.key === "team/guide")?.status,
    ).toBe("kit-unavailable")
    expect(
      reopened.installed().find((item) => item.key === "team/guide"),
    ).toEqual(savedGuide)
    expect(reopened.configuration("team/guide")).toEqual({
      scope: "repository",
      answers: { project: "Saved" },
    })
    expect(await text(join(repository, "context/guide.txt"))).toBe("Saved\n")
    await service.unregister(source)
    expect((await (await open()).catalogs()).errors).toEqual([])
  })

  test("interrupted apply recovery refuses subsequent user edits, then restores partial files, permissions and persisted configuration", async () => {
    const { service, root, home, repository, open } = await fixture()
    const item = simpleKit()
    await configure(service, item, "repository", { project: "Before" })
    await chmod(join(repository, "AGENTS.md"), 0o640)
    await chmod(join(repository, "context/guide.txt"), 0o750)
    const plan = await service.plan([
      { item, scope: "repository", answers: { project: "After" } },
    ])
    const statePath = join(home, ".loadout/state.json")
    const before = (await text(statePath))!
    const afterState = JSON.parse(before)
    afterState.repositories[repository][item.key].answers = { project: "After" }
    for (const managed of Object.values(afterState.managed) as Array<{
      type: string
      content?: string
      blocks?: Record<string, string>
    }>) {
      if (managed.type === "file") managed.content = "After\n"
      else managed.blocks![item.key] = "Work on After."
    }
    const journalPath = join(home, ".loadout/journal.json")
    const changes = await Promise.all(
      plan.changes.map(async (change) => ({
        ...change,
        beforeMode: (await stat(change.path)).mode & 0o7777,
      })),
    )
    await put(
      journalPath,
      JSON.stringify({
        before,
        after: JSON.stringify(afterState, null, 2) + "\n",
        changes,
      }),
    )
    const partialInstructions = changes.find(
      (change) => change.path === join(repository, "AGENTS.md"),
    )!
    const partialFile = changes.find(
      (change) => change.path === join(repository, "context/guide.txt"),
    )!
    for (const change of [partialInstructions, partialFile]) {
      await put(change.path, change.after!)
      await chmod(change.path, 0o600)
    }
    // Recovery must validate every target before rolling back even one file.
    await put(partialFile.path, "User edit after interruption\n")
    const interrupted = await snapshot(root)
    await expect(open()).rejects.toThrow(
      /Cannot recover a file edited after interruption/,
    )
    expect(await snapshot(root)).toEqual(interrupted)
    expect((await stat(partialInstructions.path)).mode & 0o7777).toBe(0o600)
    expect((await stat(partialFile.path)).mode & 0o7777).toBe(0o600)
    // Once the user restores the interrupted output, retry can safely roll back.
    await put(partialFile.path, partialFile.after!)
    const recovered = await open()
    expect(await text(journalPath)).toBeNull()
    expect(await text(statePath)).toBe(before)
    expect(recovered.configuration(item.key)).toEqual({
      scope: "repository",
      answers: { project: "Before" },
    })
    for (const change of changes) {
      expect(await text(change.path)).toBe(change.before)
      expect((await stat(change.path)).mode & 0o7777).toBe(change.beforeMode)
    }
    await configure(recovered, item, "repository", { project: "After" })
    expect(await text(join(repository, "context/guide.txt"))).toBe("After\n")
    expect((await stat(partialInstructions.path)).mode & 0o7777).toBe(0o640)
    expect((await stat(partialFile.path)).mode & 0o7777).toBe(0o750)
  })
})
