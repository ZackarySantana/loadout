import { afterEach, describe, expect, test } from "bun:test"
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { stringify } from "yaml"
import { LoadoutService } from "../src/backend/service"
import {
  kitSchema,
  type Answers,
  type Kit,
  type LoadedKit,
  type Scope,
} from "../src/domain/kit"

const fixtures: string[] = []
afterEach(async () => {
  for (const root of fixtures.splice(0))
    await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp("/tmp/opencode/loadout-project-catalogs-")
  fixtures.push(root)
  const home = join(root, "member-a")
  const otherHome = join(root, "member-b")
  const repository = join(root, "clone-a")
  const otherRepository = join(root, "clone-b")
  const unrelated = join(root, "unrelated-project")
  await Promise.all(
    [home, otherHome, repository, otherRepository, unrelated].map((path) =>
      mkdir(path),
    ),
  )
  const open = (repo = repository, member = home) =>
    LoadoutService.open({ home: member, repository: repo, environment: {} })
  return { root, home, otherHome, repository, otherRepository, unrelated, open }
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

// Do not follow links: status/security checks must never inspect a real external target.
async function snapshot(root: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {}
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else
        result[relative(root, path)] = entry.isSymbolicLink()
          ? { link: await readlink(path) }
          : {
              content: await readFile(path, "utf8"),
              mode: (await lstat(path)).mode & 0o7777,
            }
    }
  }
  await walk(root)
  return result
}

function guide(id = "guide", prefix = "Saved"): Kit {
  return kitSchema.parse({
    id,
    name: `${prefix} ${id}`,
    questions: [{ id: "project", label: "Project", type: "input" }],
    outputs: [
      {
        type: "instructions",
        targets: ["AGENTS.md"],
        content: `${prefix}: {{project}}`,
      },
      {
        type: "file",
        path: `context/${id}.txt`,
        content: `${prefix}: {{project}}\n`,
      },
      {
        type: "skill",
        name: id,
        files: { "SKILL.md": `# ${prefix} {{project}}` },
      },
    ],
  })
}

async function catalog(directory: string, id = "team", kits = [guide()]) {
  if (basename(directory) === ".loadout") {
    await Promise.all(
      kits.map((kit) =>
        put(join(directory, "kits", `${kit.id}.yaml`), stringify(kit)),
      ),
    )
    return join(directory, "kits")
  }
  const source = join(directory, "catalog.json")
  await Promise.all(
    kits.map((kit) => put(join(directory, `${kit.id}.yaml`), stringify(kit))),
  )
  await put(
    source,
    JSON.stringify({
      id,
      name: id,
      kits: kits.map((kit) => ({
        id: kit.id,
        name: kit.name,
        source: `${kit.id}.yaml`,
      })),
    }),
  )
  return source
}

async function select(
  service: LoadoutService,
  item: LoadedKit,
  scope: Scope,
  answers: Answers = {},
) {
  await service.apply(await service.plan([{ item, scope, answers }]))
}

async function available(
  service: LoadoutService,
  key?: string,
): Promise<LoadedKit> {
  const item = (await service.catalogs()).catalogs
    .flatMap((catalog) => catalog.kits)
    .find((item) => (key ? item.key === key : item.kit.id === "guide"))
  expect(item).toBeDefined()
  return item!
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, value]) => [key, reverseKeys(value)]),
    )
  return value
}

describe("shared project catalogs and drift", () => {
  test("committed kits work in independent clones without auto-installing or leaking into other projects", async () => {
    const { home, otherHome, repository, otherRepository, unrelated, open } =
      await fixture()
    await catalog(join(repository, ".loadout"), "team")
    const first = await open()
    expect(
      (await first.catalogs()).catalogs.find(
        (catalog) => catalog.name === "Repo",
      ),
    ).toMatchObject({ automatic: true, kind: "repo" })
    expect(first.installed()).toEqual([])
    expect(await text(join(repository, "AGENTS.md"))).toBeNull()
    // Copy only committed source material, not managed output or a user's home state.
    await cp(join(repository, ".loadout"), join(otherRepository, ".loadout"), {
      recursive: true,
    })
    const second = await open(otherRepository, otherHome)
    for (const service of [first, second]) {
      const listing = await service.catalogs()
      expect(listing.errors).toEqual([])
      expect(listing.catalogs.map((catalog) => catalog.name)).toEqual(
        expect.arrayContaining(["Loadout", "Repo"]),
      )
      expect(service.installed()).toEqual([])
    }
    await select(first, await available(first), "repository", {
      project: "Member A",
    })
    expect(second.configuration((await available(second)).key).scope).toBe(
      "none",
    )
    expect(await text(join(otherRepository, "context/guide.txt"))).toBeNull()
    await select(second, await available(second), "repository", {
      project: "Member B",
    })
    expect(await text(join(repository, "context/guide.txt"))).toBe(
      "Saved: Member A\n",
    )
    expect(await text(join(otherRepository, "context/guide.txt"))).toBe(
      "Saved: Member B\n",
    )
    expect(
      (await (await open(unrelated)).catalogs()).catalogs.flatMap((catalog) =>
        catalog.kits.map((item) => item.key),
      ),
    ).not.toContain((await available(first)).key)
    expect(
      JSON.parse((await text(join(home, ".loadout/state.json")))!).catalogs,
    ).toEqual([])
    expect(
      JSON.parse((await text(join(otherHome, ".loadout/state.json")))!)
        .catalogs,
    ).toEqual([])
  })

  test("upstream question and output changes remain an explicit reviewed update, with source changes during review rejected", async () => {
    const { root, home, repository, open } = await fixture()
    const original = guide()
    original.questions.push({
      id: "channel",
      label: "Channel",
      type: "select",
      choices: [{ value: "old", label: "Old" }],
    })
    await catalog(join(repository, ".loadout"), "team", [original])
    const service = await open()
    await select(service, await available(service), "repository", {
      project: "Atlas",
      channel: "old",
    })
    const saved = service.installed()[0]!
    const statePath = join(home, ".loadout/state.json")
    const stateBefore = await text(statePath)
    // YAML/object mapping order is not a semantic definition change.
    await put(
      join(repository, ".loadout/kits/guide.yaml"),
      stringify(reverseKeys(original)),
    )
    expect(
      (await service.status()).drift.kits.find((kit) => kit.key === saved.key)
        ?.status,
    ).toBe("current")
    const latestKit = guide("guide", "Updated")
    latestKit.questions.push(
      {
        id: "channel",
        label: "Channel",
        type: "select",
        choices: [{ value: "new", label: "New" }],
      },
      { id: "owner", label: "Owner", type: "input", required: true },
    )
    await put(
      join(repository, ".loadout/kits/guide.yaml"),
      stringify(latestKit),
    )
    const beforeStatus = await snapshot(root)
    const status = await service.status()
    const drift = status.drift.kits.find((kit) => kit.key === saved.key)!
    expect(drift.status).toBe("changed")
    expect(drift.latest?.kit).toEqual(latestKit)
    expect(await snapshot(root)).toEqual(beforeStatus)
    expect(service.installed()).toEqual([saved])
    expect(await text(join(repository, "context/guide.txt"))).toBe(
      "Saved: Atlas\n",
    )
    expect(await text(statePath)).toBe(stateBefore)
    const latest = drift.latest!
    await expect(
      service.plan([
        {
          item: latest,
          scope: "repository",
          answers: { project: "Atlas", channel: "old" },
        },
      ]),
    ).rejects.toThrow(/available options/)
    await expect(
      service.plan([
        {
          item: latest,
          scope: "repository",
          answers: { project: "Atlas", channel: "new" },
        },
      ]),
    ).rejects.toThrow(/Owner/)
    const answers = { project: "Atlas", channel: "new", owner: "Team" }
    const review = await service.plan([
      { item: latest, scope: "repository", answers },
    ])
    expect(
      review.changes.find(
        (change) => change.path === join(repository, "context/guide.txt"),
      )?.after,
    ).toBe("Updated: Atlas\n")
    const changedAgain = {
      ...latestKit,
      description: "Pulled again after review",
    }
    await put(
      join(repository, ".loadout/kits/guide.yaml"),
      stringify(changedAgain),
    )
    const afterPull = await snapshot(root)
    await expect(service.apply(review)).rejects.toThrow(
      /source changed since review/i,
    )
    expect(await snapshot(root)).toEqual(afterPull)
    expect(service.configuration(saved.key).answers).toEqual({
      project: "Atlas",
      channel: "old",
    })
    const refreshed = (await service.status()).drift.kits.find(
      (kit) => kit.key === saved.key,
    )!.latest!
    await select(service, refreshed, "repository", answers)
    expect(await text(join(repository, "context/guide.txt"))).toBe(
      "Updated: Atlas\n",
    )
    const reopened = await open()
    expect(reopened.installed()[0]!.kit).toEqual(changedAgain)
    expect(reopened.configuration(saved.key)).toEqual({
      scope: "repository",
      answers,
    })
    expect(
      (await service.status()).drift.kits.find((kit) => kit.key === saved.key)
        ?.status,
    ).toBe("current")
  })

  test("a pulled catalog keeps healthy kits available while missing entries, YAML and whole sources leave installed snapshots usable offline", async () => {
    const { root, repository, open } = await fixture()
    const directory = join(repository, "shared")
    const source = await catalog(directory, "team", [guide(), guide("healthy")])
    const originalCatalog = (await text(source))!
    const originalYaml = (await text(join(directory, "guide.yaml")))!
    const service = await open()
    await service.register("shared/catalog.json")
    await select(service, await available(service), "repository", {
      project: "Offline",
    })
    const saved = service.installed()[0]!
    for (const broken of [
      "missing-entry",
      "missing-yaml",
      "invalid-yaml",
      "missing-catalog",
      "invalid-catalog",
    ] as const) {
      await put(source, originalCatalog)
      await put(join(directory, "guide.yaml"), originalYaml)
      if (broken === "missing-entry") {
        const document = JSON.parse(originalCatalog)
        document.kits = document.kits.filter(
          (entry: { id: string }) => entry.id !== "guide",
        )
        await put(source, JSON.stringify(document))
      } else if (broken === "missing-yaml")
        await rm(join(directory, "guide.yaml"))
      else if (broken === "invalid-yaml")
        await put(join(directory, "guide.yaml"), "id: guide\noutputs: [\n")
      else if (broken === "missing-catalog") await rm(source)
      else await put(source, "{broken JSON")
      const before = await snapshot(root)
      const report = await service.status()
      const expected =
        broken === "missing-entry"
          ? "kit-missing"
          : broken.endsWith("yaml")
            ? "kit-unavailable"
            : "catalog-unavailable"
      expect(
        report.drift.kits.find((kit) => kit.key === saved.key)?.status,
      ).toBe(expected)
      expect(await snapshot(root)).toEqual(before)
      expect(service.installed()).toEqual([saved])
      expect(await text(join(repository, "context/guide.txt"))).toBe(
        "Saved: Offline\n",
      )
      if (["missing-entry", "missing-yaml", "invalid-yaml"].includes(broken)) {
        expect(
          report.catalogs
            .flatMap((catalog) => catalog.kits)
            .map((kit) => kit.key),
        ).toContain("team/healthy")
      }
      // Scope transitions always use the saved definition/answers, not unavailable YAML.
      await select(service, saved, "both", { project: "Offline" })
      expect(service.configuration(saved.key).scope).toBe("both")
      await select(service, saved, "repository", { project: "Offline" })
      expect(await text(join(repository, "context/guide.txt"))).toBe(
        "Saved: Offline\n",
      )
    }
    await put(source, originalCatalog)
    await put(join(directory, "guide.yaml"), originalYaml)
    expect(
      (await service.status()).drift.kits.find((kit) => kit.key === saved.key)
        ?.status,
    ).toBe("current")
    await rm(source)
    await service.unregister("shared/catalog.json")
    expect(
      (await service.status()).drift.kits.find((kit) => kit.key === saved.key)
        ?.status,
    ).toBe("subscription-missing")
    await select(service, saved, "none")
    expect(service.installed()).toEqual([])
    expect(await text(join(repository, "context/guide.txt"))).toBeNull()
  })

  test("status distinguishes user prose from modified, missing and unsafe managed outputs without repairing or mutating saved instruction layout", async () => {
    const { root, home, repository, open } = await fixture()
    await catalog(join(repository, ".loadout"))
    const service = await open()
    const instructions = join(repository, "AGENTS.md")
    await put(instructions, "User rules without newline")
    await select(service, await available(service), "repository", {
      project: "Atlas",
    })
    const saved = service.installed()[0]!
    const statePath = join(home, ".loadout/state.json")
    const stateBefore = await text(statePath)
    await put(instructions, `${await text(instructions)}\nUser footer\n`)
    const withProse = await snapshot(root)
    const healthy = await service.status()
    expect(
      healthy.drift.files.find((file) => file.path === instructions)?.status,
    ).toBe("current")
    expect(await snapshot(root)).toEqual(withProse)
    expect(await text(statePath)).toBe(stateBefore)
    // A no-op review after status must keep every original layout byte, not just its block.
    expect(
      (
        await service.plan([
          { item: saved, scope: "repository", answers: { project: "Atlas" } },
        ])
      ).changes,
    ).toEqual([])
    const originalInstructions = (await text(instructions))!
    const missing = join(repository, ".agents/skills/guide/SKILL.md")
    const unsafe = join(repository, ".claude/skills/guide/SKILL.md")
    const outside = join(root, "user-owned-skill.md")
    await put(outside, "User-owned target\n")
    await put(
      instructions,
      originalInstructions.replace(
        "Saved: Atlas",
        "User edited the managed block",
      ),
    )
    await put(join(repository, "context/guide.txt"), "Locally changed file\n")
    await rm(missing)
    await rm(unsafe)
    await symlink(outside, unsafe)
    const conflicted = await snapshot(root)
    const report = await service.status()
    expect(
      report.drift.files.find((file) => file.path === instructions)?.status,
    ).toBe("modified")
    expect(
      report.drift.files.find(
        (file) => file.path === join(repository, "context/guide.txt"),
      )?.status,
    ).toBe("modified")
    expect(
      report.drift.files.find((file) => file.path === missing)?.status,
    ).toBe("missing")
    expect(
      report.drift.files.find((file) => file.path === unsafe)?.status,
    ).toBe("unsafe")
    expect(await snapshot(root)).toEqual(conflicted)
    expect(await text(statePath)).toBe(stateBefore)
    await expect(
      service.plan([{ item: saved, scope: "none", answers: {} }]),
    ).rejects.toThrow(/edited|symlink/)
    expect(await snapshot(root)).toEqual(conflicted)
    // Only explicit user restoration resolves drift; status does not repair files.
    await put(instructions, originalInstructions)
    await put(join(repository, "context/guide.txt"), "Saved: Atlas\n")
    await put(missing, "# Saved Atlas")
    await rm(unsafe)
    await put(unsafe, "# Saved Atlas")
    expect(
      (await service.status()).drift.files.every(
        (file) => file.status === "current",
      ),
    ).toBe(true)
    await select(service, saved, "none")
    expect(await text(instructions)).toBe(
      "User rules without newline\nUser footer\n",
    )
  })

  test("global snapshots keep their repository-A provenance in repository B, and both restores A offline", async () => {
    const { home, repository, otherRepository, open } = await fixture()
    const sourceA = await catalog(join(repository, ".loadout"), "team", [
      guide("guide", "From A"),
    ])
    await catalog(join(otherRepository, ".loadout"), "team", [
      guide("guide", "From B"),
    ])
    const a = await open()
    const originalA = await available(a)
    await select(a, originalA, "both", { project: "Alpha" })
    const b = await open(otherRepository)
    expect((await available(b)).kit.name).toBe("From B guide")
    expect(b.installed()).toEqual([originalA])
    expect(
      (await b.status()).drift.kits.find((kit) => kit.key === originalA.key),
    ).toMatchObject({
      status: "current",
      origin: { source: sourceA, repository },
    })
    await put(
      join(repository, ".loadout/kits/guide.yaml"),
      stringify(guide("guide", "Changed A")),
    )
    const changed = (await b.status()).drift.kits.find(
      (kit) => kit.key === originalA.key,
    )!
    expect(changed.status).toBe("changed")
    expect(changed.latest?.kit.name).toBe("Changed A guide")
    expect(changed.latest?.origin?.source).toBe(sourceA)
    expect(b.installed()).toEqual([originalA])
    expect(await text(join(home, "context/guide.txt"))).toBe("From A: Alpha\n")
    // Leave the catalog subscribed but take A's YAML offline. B must not fill the gap.
    await rm(join(repository, ".loadout/kits/guide.yaml"))
    const offline = (await b.status()).drift.kits.find(
      (kit) => kit.key === originalA.key,
    )!
    expect(offline.status).toBe("kit-missing")
    expect(offline.latest).toBeUndefined()
    await select(b, b.installed()[0]!, "none")
    await a.refresh()
    expect(a.configuration(originalA.key)).toEqual({
      scope: "repository",
      answers: { project: "Alpha" },
    })
    expect(a.installed()).toEqual([originalA])
    expect(await text(join(home, "context/guide.txt"))).toBeNull()
    expect(await text(join(repository, "context/guide.txt"))).toBe(
      "From A: Alpha\n",
    )
    expect(await text(join(otherRepository, "context/guide.txt"))).toBeNull()
    expect(
      (await a.status()).drift.kits.find((kit) => kit.key === originalA.key)
        ?.status,
    ).toBe("kit-missing")
  })

  test("a missing globally registered source can be unregistered without discarding its installed offline snapshot", async () => {
    const { root, home, repository, unrelated, open } = await fixture()
    const source = await catalog(join(root, "personal-catalog"), "personal")
    const service = await open()
    await service.register(source)
    await select(
      service,
      await available(service, "personal/guide"),
      "global",
      { project: "Personal" },
    )
    const anotherProject = await open(unrelated)
    expect(
      (await anotherProject.catalogs()).catalogs.map((catalog) => catalog.id),
    ).toContain("personal")
    await rm(source)
    const before = await snapshot(root)
    expect(
      (await anotherProject.status()).drift.kits.find(
        (kit) => kit.key === "personal/guide",
      )?.status,
    ).toBe("catalog-unavailable")
    expect(await snapshot(root)).toEqual(before)
    await anotherProject.unregister(source)
    expect(
      JSON.parse((await text(join(home, ".loadout/state.json")))!).catalogs,
    ).toEqual([])
    expect(anotherProject.configuration("personal/guide")).toEqual({
      scope: "global",
      answers: { project: "Personal" },
    })
    const saved = anotherProject.installed()[0]!
    await select(anotherProject, saved, "both", { project: "Personal" })
    expect(await text(join(home, "context/guide.txt"))).toBe(
      "Saved: Personal\n",
    )
    expect(await text(join(unrelated, "context/guide.txt"))).toBeNull()
    await select(anotherProject, saved, "repository", { project: "Personal" })
    expect(await text(join(home, "context/guide.txt"))).toBeNull()
    expect(await text(join(unrelated, "context/guide.txt"))).toBe(
      "Saved: Personal\n",
    )
    expect(await text(join(repository, "context/guide.txt"))).toBeNull()
  })
})
