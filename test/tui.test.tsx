import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { testRender } from "@opentui/solid"
import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextAttributes,
  RGBA,
  type Renderable,
} from "@opentui/core"
import { stringify } from "yaml"
import { App } from "../src/frontend/App"
import { ScreenModel } from "../src/frontend/model"
import { LoadoutService } from "../src/backend/service"

const cleanups: (() => Promise<void>)[] = []
const descendants = (node: Renderable): Renderable[] => [
  node,
  ...node.getChildren().flatMap(descendants),
]
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(register = true, richPreview = false) {
  const root = await mkdtemp("/tmp/opencode/loadout-tui-")
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const home = join(root, "home")
  const repository = join(root, "repo")
  const directory = join(root, "local catalog")
  await Promise.all([home, repository, directory].map((path) => mkdir(path)))
  const source = join(directory, "catalog.json")
  await writeFile(
    join(directory, "kit.yaml"),
    stringify({
      id: "team",
      name: "Team context",
      description: "Small deterministic team kit.",
      questions: [
        { id: "source", type: "input", label: "Team name" },
        {
          id: "style",
          type: "select",
          label: "Style",
          choices: [
            { value: "brief", label: "Brief" },
            { value: "detailed", label: "Detailed" },
          ],
        },
        {
          id: "checks",
          type: "multi-select",
          label: "Checks",
          choices: [
            { value: "lint", label: "Lint" },
            { value: "test", label: "Tests" },
          ],
        },
        { id: "extra", type: "boolean", label: "Add extra notes" },
        {
          id: "note",
          type: "input",
          label: "Extra note",
          when: { question: "extra", equals: true },
        },
        {
          id: "followup",
          type: "input",
          label: "Follow-up owner",
          when: { question: "note", equals: "Needs follow-up" },
        },
      ],
      outputs: [
        {
          type: "instructions",
          targets: ["AGENTS.md"],
          content: richPreview
            ? "# Team charter\n\n**Owner**: {{source}}\n\nStyle: {{style}}\n"
            : "Team: {{source}}\nStyle: {{style}}\nChecks: {{checks}}\n",
        },
        {
          type: "file",
          path: "notes.txt",
          content: "{{note}}\n",
          when: { question: "extra", equals: true },
        },
        {
          type: "file",
          path: "followup.txt",
          content: "Owner: {{followup}}\n",
          when: { question: "note", equals: "Needs follow-up" },
        },
        ...(richPreview
          ? [
              {
                type: "skill",
                name: "team-guide",
                files: {
                  "SKILL.md":
                    "# Runbook\n\n**Owner**: {{source}}\n\n```sh\nprintf 'Ready to review'\n```\n\n---\n\nCheck the rollout plan.\n",
                },
                when: { question: "extra", equals: true },
              },
            ]
          : []),
      ],
    }),
  )
  await writeFile(
    source,
    JSON.stringify({
      id: "fixture",
      name: "Local team catalog",
      description: Array.from(
        { length: 40 },
        (_, i) => `Catalog preview paragraph ${i + 1}.`,
      ).join("\n\n"),
      kits: [{ id: "team", name: "Team context", source: "kit.yaml" }],
    }),
  )
  const service = await LoadoutService.open({ home, repository })
  if (register) await service.register(source)
  const model = new ScreenModel(service)
  await model.initialize()
  let exits = 0
  const setup = await testRender(
    () => (
      <App
        model={model}
        onExit={() => {
          exits++
        }}
      />
    ),
    { width: 110, height: 40, kittyKeyboard: true },
  )
  cleanups.push(() => setup.dispose())
  await setup.flush()
  const frame = () => setup.captureCharFrame()
  const settle = async () => {
    // Visual idle can precede completion of the real service's filesystem work.
    await setup.waitFor(async () => {
      for (let attempt = 0; model.busy && attempt < 200; attempt++)
        await Bun.sleep(5)
      return !model.busy
    })
    await setup.flush()
  }
  const press = async (key: string) => {
    setup.mockInput.pressKey(key)
    await settle()
  }
  // Navigate only through the rendered keyboard handler; row IDs locate the destination,
  // rather than mutating model.cursor or calling model actions directly.
  const go = async (id: string) => {
    const target = model.rows().findIndex((row) => row.id === id)
    expect(target).toBeGreaterThanOrEqual(0)
    for (
      let attempts = 0;
      model.selected()?.id !== id && attempts < 80;
      attempts++
    ) {
      await press(model.cursor < target ? "ARROW_DOWN" : "ARROW_UP")
    }
    expect(model.selected()?.id).toBe(id)
  }
  const select = async (id: string) => {
    await go(id)
    await press(" ")
  }
  const focusOption = async (id: string, value: string | boolean) => {
    await go(id)
    const target = model
      .selected()!
      .choices!.findIndex((choice) => choice.value === value)
    expect(target).toBeGreaterThanOrEqual(0)
    for (
      let attempt = 0;
      model.selected()!.focusedOptionIndex !== target && attempt < 20;
      attempt++
    ) {
      const before = model.cursor
      await press(
        (model.selected()!.focusedOptionIndex ?? 0) < target
          ? "ARROW_RIGHT"
          : "ARROW_LEFT",
      )
      expect(model.cursor).toBe(before)
    }
    expect(model.selected()!.focusedOptionIndex).toBe(target)
  }
  const choose = async (id: string, value: string | boolean) => {
    await focusOption(id, value)
    await press(" ")
  }
  const answer = async (id: string, value: string) => {
    await select(`question:${id}`)
    expect(frame()).toContain("Type an answer")
    await setup.mockInput.typeText(value)
    await setup.flush()
    await press("RETURN")
    expect(frame()).toContain(value)
    expect(model.editing).toBeUndefined()
  }
  const openKit = async () => {
    await select("catalog:fixture")
    expect(frame()).toContain("Catalogs / Local team catalog")
    expect(frame()).toContain("AGENTS.md")
    await select("kit:fixture/team")
    expect(frame()).toContain("Install where?")
    expect(frame()).toContain("◉ Repository")
  }
  return {
    home,
    repository,
    source,
    service,
    model,
    setup,
    frame,
    press,
    go,
    select,
    choose,
    focusOption,
    answer,
    openKit,
    settle,
    exits: () => exits,
  }
}

describe("rendered keyboard workflows", () => {
  test("configures every question type, reviews real diffs, defaults to cancel, then applies", async () => {
    const ui = await fixture()
    const agents = join(ui.repository, "AGENTS.md")
    await writeFile(agents, "Keep my existing instructions.\n")
    expect(ui.frame()).toContain("◆ Loadout")
    await ui.openKit()
    const scopeOptions = [0, 1, 2, 3].map(
      (index) =>
        ui.setup.renderer.root.findDescendantById(
          `scope:option:${index}`,
        ) as TextRenderable,
    )
    expect(new Set(scopeOptions.map((option) => option.y)).size).toBe(1)
    expect(scopeOptions[1]!.x).toBeGreaterThan(scopeOptions[0]!.x)
    const scopeColors: string[] = []
    for (const [index, scope] of ["repository", "global", "both"].entries()) {
      await ui.focusOption("scope", scope)
      // Merely focusing a horizontal option must not choose it.
      if (scope === "global") expect(ui.model.form?.scope).toBe("repository")
      await ui.press(" ")
      const option = ui.setup.renderer.root.findDescendantById(
        `scope:option:${index}`,
      ) as TextRenderable
      scopeColors.push(option.fg.toInts().join(","))
      const scopeLine = descendants(ui.setup.renderer.root).find(
        (node) =>
          node instanceof TextRenderable && node.plainText.includes("Scope:"),
      ) as TextRenderable
      const rightScope = ui.setup
        .captureSpans()
        .lines.slice(scopeLine.y, scopeLine.y + scopeLine.height)
        .flatMap((line) => line.spans)
        .find((span) => span.text === scope)
      expect(rightScope?.fg.equals(option.fg)).toBe(true)
      await ui.select("save")
      // Required input prevents staging until we fill it below.
      expect(ui.frame()).toContain("Team name: enter a value")
    }
    expect(new Set(scopeColors).size).toBe(3)
    await ui.choose("scope", "repository")
    expect(ui.frame()).not.toContain("Extra note:")
    await ui.answer("source", "Platform team west")
    for (const id of ["style", "checks", "extra"]) {
      const first = ui.setup.renderer.root.findDescendantById(
        `question:${id}:option:0`,
      )!
      const second = ui.setup.renderer.root.findDescendantById(
        `question:${id}:option:1`,
      )!
      expect(second.y).toBe(first.y)
      expect(second.x).toBeGreaterThan(first.x)
    }
    await ui.choose("question:style", "detailed")
    expect(ui.frame()).toContain("◉ Detailed")
    await ui.choose("question:checks", "lint")
    await ui.choose("question:checks", "test")
    await ui.choose("question:checks", "lint")
    expect(ui.frame()).toContain("☐ Lint")
    expect(ui.frame()).toContain("☑ Tests")
    await ui.choose("question:extra", true)
    expect(ui.frame()).toContain("Extra note:")
    await ui.answer("note", "Review before merging")
    await ui.select("save")
    expect(ui.frame()).toContain("1 staged")
    expect(ui.frame()).toContain("Team context  [repository] *")
    const stagedRow =
      ui.setup.renderer.root.findDescendantById("kit:fixture/team")!
    const badge = ui.setup
      .captureSpans()
      .lines.slice(stagedRow.y, stagedRow.y + stagedRow.height)
      .flatMap((line) => line.spans)
      .find((span) => span.text.includes("[repository]"))
    expect(badge?.fg?.toInts().join(",")).toBe(scopeColors[0])
    expect(await readFile(agents, "utf8")).toBe(
      "Keep my existing instructions.\n",
    )
    expect(await Bun.file(join(ui.repository, "notes.txt")).exists()).toBe(
      false,
    )

    await ui.press("TAB")
    expect(ui.model.page).toBe(1)
    expect(ui.frame()).toContain("Team context")
    await ui.press("TAB")
    expect(ui.frame()).toContain("Apply 2 file changes")
    await ui.select("change:0")
    expect(ui.frame()).toContain("Keep my existing")
    expect(ui.frame()).toContain("Platform team west")
    await ui.go("change:1")
    expect(ui.frame()).toContain("Review before merging")
    await ui.select("apply")
    expect(ui.frame()).toContain("› Go back without applying")
    await ui.press(" ")
    expect(ui.model.confirming).toBe(false)
    expect(await readFile(agents, "utf8")).toBe(
      "Keep my existing instructions.\n",
    )
    await ui.select("apply")
    await ui.select("confirm")
    await ui.setup.waitFor(() =>
      ui.model.message.startsWith("Applied successfully"),
    )
    expect(ui.frame()).toContain("Applied successfully")
    const content = await readFile(agents, "utf8")
    expect(content).toContain("Keep my existing instructions.")
    expect(content).toContain(
      "Team: Platform team west\nStyle: detailed\nChecks: test",
    )
    expect(await readFile(join(ui.repository, "notes.txt"), "utf8")).toBe(
      "Review before merging\n",
    )
    const reopened = await LoadoutService.open({
      home: ui.home,
      repository: ui.repository,
    })
    expect(reopened.configuration("fixture/team")).toEqual({
      scope: "repository",
      answers: {
        source: "Platform team west",
        style: "detailed",
        checks: ["test"],
        extra: true,
        note: "Review before merging",
      },
    })
    await ui.press("TAB")
    await ui.press("TAB")
    expect(ui.frame()).toContain("Team context  [repository]")
    expect(ui.model.drafts.size).toBe(0)
  })

  test("registers a catalog through the inline path input, including spaces, and persists it", async () => {
    const ui = await fixture(false)
    expect(ui.frame()).toContain("◆ Loadout")
    const catalogCards = ["Greenfield", "No em dashes"].map((name) => {
      const title = descendants(ui.setup.renderer.root).find(
        (node) => node instanceof TextRenderable && node.plainText === name,
      )!
      expect(title.parent).toBeInstanceOf(BoxRenderable)
      const card = title.parent as BoxRenderable
      expect(card.border).toBe(true)
      expect(
        descendants(card).some(
          (node) =>
            node instanceof TextRenderable &&
            node.plainText.includes("Instructions"),
        ),
      ).toBe(true)
      expect(card.getChildren().length).toBeGreaterThanOrEqual(3)
      return card
    })
    expect(catalogCards[0]!.parent).toBe(catalogCards[1]!.parent)
    expect(catalogCards[1]!.y).toBeGreaterThan(
      catalogCards[0]!.y + catalogCards[0]!.height,
    )
    await ui.select("catalog:loadout")
    expect(ui.frame()).toContain("Catalogs / Loadout")
    expect(ui.model.rows().some((row) => row.kind === "kit")).toBe(true)
    await ui.press("ESCAPE")
    await ui.select("register")
    expect(ui.frame()).toContain("Catalog JSON path or HTTPS URL")
    await ui.setup.mockInput.typeText(ui.source)
    await ui.setup.flush()
    expect(ui.model.source).toBe(ui.source)
    await ui.press("RETURN")
    await ui.setup.waitFor(() =>
      ui.model.message.startsWith("Catalog registered"),
    )
    expect(ui.frame()).toContain("Local team catalog")
    expect(ui.frame()).toContain("Catalog registered")
    await ui.press(" ")
    expect(ui.frame()).toContain("Catalogs / Local team catalog")
    expect(ui.frame()).toContain("Team context")
    const reopened = await LoadoutService.open({
      home: ui.home,
      repository: ui.repository,
    })
    expect(
      (await reopened.catalogs()).catalogs.map((catalog) => catalog.id),
    ).toEqual(["loadout", "fixture"])
    expect(await Bun.file(join(ui.repository, "AGENTS.md")).exists()).toBe(
      false,
    )
    await ui.press("q")
    expect(ui.frame()).toContain("Exit Loadout?")
    await ui.press(" ")
    expect(ui.exits()).toBe(0)
    await ui.press("ESCAPE")
    expect(ui.frame()).not.toContain("Exit Loadout?")
    await ui.press("q")
    await ui.press("q")
    expect(ui.exits()).toBe(1)
  })

  test("blocks tabbing out of a form, cancels edits, and requires deliberate dirty exit", async () => {
    const ui = await fixture()
    await ui.openKit()
    await ui.select("question:source")
    await ui.setup.mockInput.typeText("Discard this text q")
    await ui.press("ESCAPE")
    expect(ui.model.editing).toBeUndefined()
    expect(ui.frame()).toContain("Team name: Discard this text q")
    expect(ui.frame()).not.toContain("Exit Loadout?")
    await ui.press("TAB")
    expect(ui.frame()).toContain("Stage or cancel the inline form")
    expect(ui.model.page).toBe(0)
    await ui.select("cancel")
    expect(ui.frame()).not.toContain("Install where?")
    expect(ui.model.drafts.size).toBe(0)
    await ui.select("kit:fixture/team")
    expect(ui.frame()).toContain("Team name: (enter a value)")
    await ui.select("save")
    expect(ui.frame()).toContain("Team name: enter a value")
    await ui.answer("source", "Staged team")
    await ui.select("save")
    await ui.select("kit:fixture/team")
    await ui.choose("scope", "global")
    await ui.press("ESCAPE")
    expect(ui.frame()).toContain("Team context  [repository] *")
    await ui.press("q")
    expect(ui.frame()).toContain("Exit Loadout?")
    expect(ui.frame()).toContain("q exit · Esc stay")
    await ui.press(" ")
    expect(ui.exits()).toBe(0)
    await ui.press("RETURN")
    expect(ui.exits()).toBe(0)
    await ui.press("ESCAPE")
    expect(ui.frame()).not.toContain("Exit Loadout?")
    await ui.press("q")
    await ui.press("q")
    expect(ui.exits()).toBe(1)
    expect(await Bun.file(join(ui.repository, "AGENTS.md")).exists()).toBe(
      false,
    )
    expect(ui.service.installed()).toEqual([])
  })

  test("scrolls details and keeps inline selection visible after a narrow resize", async () => {
    const ui = await fixture()
    const checkColumns = (width: number) => {
      const row = ui.setup.renderer.root.findDescendantById(
        ui.model.rows()[0]!.id,
      )!
      let panel = row
      while (
        panel.parent &&
        !(panel instanceof BoxRenderable && panel.title?.startsWith("Catalogs"))
      )
        panel = panel.parent
      const columns = panel.parent!.getChildren()
      expect(columns.length).toBe(2)
      const [left, right] = columns
      const available = left!.width + right!.width
      expect(Math.abs(left!.width / available - 0.7)).toBeLessThan(0.06)
      expect(Math.abs(right!.width / available - 0.3)).toBeLessThan(0.06)
      expect(right!.x).toBeGreaterThanOrEqual(left!.x + left!.width)
      expect(right!.x + right!.width).toBeLessThanOrEqual(width)
      expect(available).toBeGreaterThan(width - 8)
    }
    checkColumns(110)
    await ui.go("catalog:fixture")
    expect(ui.frame()).toContain("Catalog preview paragraph 1.")
    expect(ui.frame()).not.toContain("Catalog preview paragraph 40.")
    ui.setup.mockInput.pressKey("\u001b[6~")
    await ui.setup.flush()
    expect(ui.frame()).not.toContain("Catalog preview paragraph 1.")
    ui.setup.mockInput.pressKey("\u001b[5~")
    await ui.setup.flush()
    expect(ui.frame()).toContain("Catalog preview paragraph 1.")
    await ui.openKit()
    ui.setup.resize(64, 18)
    await ui.setup.flush()
    checkColumns(64)
    const repositoryOption =
      ui.setup.renderer.root.findDescendantById("scope:option:0")!
    const globalOption =
      ui.setup.renderer.root.findDescendantById("scope:option:1")!
    const lastOption =
      ui.setup.renderer.root.findDescendantById("scope:option:3")!
    expect(globalOption.y).toBe(repositoryOption.y)
    expect(globalOption.x).toBeGreaterThan(repositoryOption.x)
    expect(lastOption.y).toBeGreaterThan(repositoryOption.y)
    await ui.focusOption("scope", "global")
    expect(ui.model.form?.scope).toBe("repository")
    await ui.press("ARROW_LEFT")
    expect(ui.model.selected()?.id).toBe("scope")
    await ui.press("ARROW_DOWN")
    expect(ui.model.selected()?.id).toBe("question:source")
    await ui.go("save")
    expect(ui.frame()).toContain("› ✓ Stage")
    await ui.press(" ")
    expect(ui.frame()).toContain("Team name: enter a value")
    await ui.go("question:source")
    expect(ui.frame()).toContain("› Team name:")
    await ui.answer("source", "Narrow screen team")
    await ui.select("save")
    expect(ui.frame()).toContain("1 staged")
    await ui.press("TAB")
    expect(ui.frame()).toContain("Team context")
    ui.setup.mockInput.pressTab({ shift: true })
    await ui.settle()
    expect(ui.model.page).toBe(0)
    expect(ui.frame()).toContain("Team context")
    ui.setup.resize(110, 40)
    await ui.setup.flush()
    expect(ui.frame()).toContain("Catalogs / Local team catalog")
  })

  test("hides cascading questions and excludes their outputs when an ancestor is disabled", async () => {
    const ui = await fixture()
    await ui.openKit()
    await ui.answer("source", "Conditional team")
    await ui.choose("question:extra", true)
    await ui.answer("note", "Needs follow-up")
    expect(ui.frame()).toContain("Follow-up owner:")
    await ui.answer("followup", "Release team")
    await ui.choose("question:extra", false)
    expect(ui.frame()).not.toContain("Extra note:")
    expect(ui.frame()).not.toContain("Follow-up owner:")
    expect(ui.model.rows().some((row) => row.id === "question:followup")).toBe(
      false,
    )
    // The preview must also evaluate the cascade, not stale hidden note values.
    ui.setup.mockInput.pressKey("\u001b[6~")
    await ui.setup.flush()
    expect(ui.frame()).toContain("followup.txt")
    expect(ui.frame()).toContain("Not included")
    await ui.select("save")
    expect(ui.model.drafts.get("fixture/team")?.answers).toEqual({
      source: "Conditional team",
      style: "brief",
      checks: [],
      extra: false,
    })
    await ui.press("TAB")
    await ui.press("TAB")
    expect(ui.frame()).toContain("Apply 1 file changes")
    expect(ui.model.plan?.changes.map((change) => change.path)).toEqual([
      join(ui.repository, "AGENTS.md"),
    ])
    await ui.select("apply")
    await ui.select("confirm")
    expect(ui.frame()).toContain("Applied successfully")
    expect(ui.service.configuration("fixture/team").answers).toEqual({
      source: "Conditional team",
      style: "brief",
      checks: [],
      extra: false,
    })
    expect(await Bun.file(join(ui.repository, "notes.txt")).exists()).toBe(
      false,
    )
    expect(await Bun.file(join(ui.repository, "followup.txt")).exists()).toBe(
      false,
    )
    expect(await readFile(join(ui.repository, "AGENTS.md"), "utf8")).toContain(
      "Team: Conditional team",
    )
  })

  test("renders live Markdown in separate contribution cards and restores excluded styles when reenabled", async () => {
    const ui = await fixture(true, true)
    await ui.openKit()
    ui.setup.resize(150, 70)
    await ui.setup.flush()
    const card = (label: string) => {
      const heading = descendants(ui.setup.renderer.root).find(
        (node) => node instanceof TextRenderable && node.plainText === label,
      )
      expect(heading).toBeDefined()
      expect(heading!.parent).toBeInstanceOf(BoxRenderable)
      const box = heading!.parent as BoxRenderable
      expect(box.border).toBe(true)
      return { box, heading: heading as TextRenderable }
    }
    const spansIn = (box: BoxRenderable) =>
      ui.setup
        .captureSpans()
        .lines.slice(Math.max(0, box.y), box.y + box.height)
        .flatMap((line) => {
          let x = 0
          return line.spans.flatMap((span) => {
            const start = x
            x += span.width
            const left = Math.max(start, box.x)
            const right = Math.min(x, box.x + box.width)
            if (left >= right) return []
            // Adjacent same-colored cells can merge across card boundaries.
            // All text in this fixture is single-column, including box glyphs.
            return [
              {
                ...span,
                text: Array.from(span.text)
                  .slice(left - start, right - start)
                  .join(""),
                width: right - left,
              },
            ]
          })
        })
    const instructions = card("Instructions · AGENTS.md")
    const file = card("File · notes.txt")
    const skill = card("Skill · team-guide")
    expect(new Set([instructions.box, file.box, skill.box]).size).toBe(3)
    expect(file.box.parent).toBe(instructions.box.parent)
    expect(skill.box.parent).toBe(instructions.box.parent)
    expect(file.box.y).toBeGreaterThanOrEqual(
      instructions.box.y + instructions.box.height,
    )
    expect(skill.box.y).toBeGreaterThanOrEqual(file.box.y + file.box.height)

    await ui.select("question:source")
    await ui.setup.mockInput.typeText("Alpha")
    await ui.setup.flush()
    expect(ui.frame()).toContain("Owner: Alpha")
    const headingSpan = spansIn(card("Instructions · AGENTS.md").box).find(
      (span) => span.text.includes("Team charter"),
    )
    expect(headingSpan).toBeDefined()
    expect(headingSpan!.attributes & TextAttributes.BOLD).toBe(
      TextAttributes.BOLD,
    )
    const strongSpan = spansIn(card("Instructions · AGENTS.md").box).find(
      (span) => span.text.includes("Owner"),
    )
    expect(strongSpan).toBeDefined()
    expect(strongSpan!.attributes & TextAttributes.BOLD).toBe(
      TextAttributes.BOLD,
    )
    expect(ui.frame()).not.toContain("# Team charter")
    expect(ui.frame()).not.toContain("**Owner**")
    for (let i = 0; i < 5; i++) ui.setup.mockInput.pressBackspace()
    await ui.setup.mockInput.typeText("Beta")
    await ui.setup.flush()
    expect(ui.frame()).toContain("Owner: Beta")
    expect(ui.frame()).not.toContain("Owner: Alpha")
    await ui.press("RETURN")

    const checkExcluded = (excluded: boolean) => {
      const gray = RGBA.fromHex("#858b87")
      for (const label of ["File · notes.txt", "Skill · team-guide"]) {
        const current = card(label)
        expect(current.box.borderColor.equals(gray)).toBe(excluded)
        expect(current.heading.fg.equals(gray)).toBe(excluded)
        const body = spansIn(current.box).filter((span) =>
          span.text.includes(
            label.startsWith("Skill") ? "Runbook" : "{{note}}",
          ),
        )
        expect(body.length).toBeGreaterThan(0)
        expect(body.every((span) => span.fg.equals(gray))).toBe(excluded)
        if (label.startsWith("Skill")) {
          const liveAnswer = spansIn(current.box).filter((span) =>
            span.text.includes("Beta"),
          )
          expect(liveAnswer.length).toBeGreaterThan(0)
          expect(liveAnswer.every((span) => span.fg.equals(gray))).toBe(
            excluded,
          )
          // Markdown creates distinct code/rule children. Their colors must
          // update too, not only the containing markdown's foreground.
          const code = descendants(current.box).find(
            (node) =>
              node instanceof TextRenderable &&
              node.plainText.includes("printf 'Ready to review'"),
          ) as TextRenderable | undefined
          expect(code).toBeDefined()
          expect(
            code!.fg.equals(RGBA.fromHex(excluded ? "#858b87" : "#bbd4a4")),
          ).toBe(true)
          const codeSpans = spansIn(current.box).filter((span) =>
            span.text.includes("Ready to review"),
          )
          expect(codeSpans.length).toBeGreaterThan(0)
          expect(codeSpans.every((span) => span.fg.equals(code!.fg))).toBe(true)
          const rule = descendants(current.box).find(
            (node) =>
              node instanceof BoxRenderable &&
              Array.isArray(node.border) &&
              node.border.length === 1 &&
              node.border[0] === "top",
          ) as BoxRenderable | undefined
          expect(rule).toBeDefined()
          expect(
            rule!.borderColor.equals(
              RGBA.fromHex(excluded ? "#858b87" : "#526c55"),
            ),
          ).toBe(true)
          const ruleSpans = spansIn(rule!).filter((span) =>
            span.text.includes("─"),
          )
          expect(ruleSpans.length).toBeGreaterThan(0)
          expect(
            ruleSpans.every((span) => span.fg.equals(rule!.borderColor)),
          ).toBe(true)
        }
        const status = descendants(current.box).some(
          (node) =>
            node instanceof TextRenderable && node.plainText === "Not included",
        )
        expect(status).toBe(excluded)
      }
    }
    checkExcluded(true)
    await ui.choose("question:extra", true)
    checkExcluded(false)
    // Keep the same preview identity while navigating/toggling this kit.
    // A shorter included card may clamp the old offset, but must not reset it.
    await ui.focusOption("question:extra", false)
    ui.setup.resize(150, 32)
    await ui.setup.flush()
    let ancestor: Renderable | null = card("Skill · team-guide").box.parent
    while (ancestor && !(ancestor instanceof ScrollBoxRenderable))
      ancestor = ancestor.parent
    expect(ancestor).toBeInstanceOf(ScrollBoxRenderable)
    const preview = ancestor as ScrollBoxRenderable
    await ui.press("\u001b[6~")
    const offset = preview.scrollTop
    expect(offset).toBeGreaterThan(0)
    await ui.press(" ")
    expect(preview.scrollTop).toBe(
      Math.min(
        offset,
        Math.max(0, preview.scrollHeight - preview.viewport.height),
      ),
    )
    expect(preview.scrollTop).toBeGreaterThan(0)
    ui.setup.resize(150, 70)
    await ui.setup.flush()
    await ui.press("\u001b[5~")
    expect(ui.frame()).toContain("Owner: Beta")
    checkExcluded(true)
    await ui.choose("question:extra", true)
    checkExcluded(false)
    expect(ui.model.drafts.size).toBe(0)
    expect(await Bun.file(join(ui.repository, "AGENTS.md")).exists()).toBe(
      false,
    )
  })
})
