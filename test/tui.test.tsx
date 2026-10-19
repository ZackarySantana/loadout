import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { testRender } from "@opentui/solid"
import { TestRecorder } from "@opentui/core/testing"
import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  TextBufferRenderable,
  InputRenderable,
  TextAttributes,
  RGBA,
  MarkdownRenderable,
  CodeRenderable,
  type Renderable,
} from "@opentui/core"
import { stringify } from "yaml"
import { App } from "../src/frontend/App"
import { ScreenModel } from "../src/frontend/model"
import { LoadoutService } from "../src/backend/service"

const cleanups: (() => Promise<void>)[] = []
const proseRun =
  "ProseRunABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
const codeRun =
  "CodeRun0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const skillDocument = `---\r\nname: team-guide\r\ndescription: Guide for {{source}}.\r\n---\r\n\r\n# Runbook\n\n**Owner**: {{source}}\n\n\`\`\`sh\nprintf 'Ready to review'\n${codeRun}\n\`\`\`\n\n---\n\nCheck the rollout plan.\n`
const descendants = (node: Renderable): Renderable[] => [
  node,
  ...node.getChildren().flatMap(descendants),
]
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(
  register = true,
  richPreview = false,
  neighbors = false,
) {
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
        {
          id: "source",
          type: "input",
          label: "Team name",
          description: "Name used in generated context.",
        },
        {
          id: "style",
          type: "select",
          label: "Style",
          description: "Choose the level of detail.",
          choices: [
            { value: "brief", label: "Brief" },
            { value: "detailed", label: "Detailed" },
          ],
        },
        {
          id: "checks",
          type: "multi-select",
          label: "Checks",
          description: "Select the checks to include.",
          choices: [
            { value: "lint", label: "Lint" },
            { value: "test", label: "Tests" },
          ],
        },
        {
          id: "extra",
          type: "boolean",
          label: "Add extra notes",
          description: "Enable optional notes.",
        },
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
        ...(richPreview
          ? [
              {
                id: "unrelated",
                type: "boolean",
                label: "Unrelated preference",
              },
              {
                id: "scratch",
                type: "input",
                label: "Scratch answer",
                required: false,
              },
            ]
          : []),
      ],
      outputs: [
        {
          type: "instructions",
          targets: richPreview ? ["AGENTS.md", "CLAUDE.md"] : ["AGENTS.md"],
          content: richPreview
            ? `# Team charter\n\n**Owner**: {{source}}\n\nStyle: {{style}}\n\n${proseRun}\n`
            : "Team: {{source}}\nStyle: {{style}}\nChecks: {{checks}}\n",
        },
        ...(richPreview
          ? [
              {
                type: "instructions",
                targets: ["AGENTS.md", "CLAUDE.md"],
                content:
                  "## Optional context\n\nAdditional guidance for {{source}}.\n",
                when: { question: "extra", equals: true },
              },
            ]
          : []),
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
                  "SKILL.md": skillDocument,
                  "references/checklist.md": "Checklist for {{source}}.\n",
                },
                when: { question: "extra", equals: true },
              },
            ]
          : []),
      ],
    }),
  )
  if (neighbors)
    for (const id of ["before", "after"]) {
      await writeFile(
        join(directory, `${id}.yaml`),
        stringify({
          id,
          name: `${id === "before" ? "Before" : "After"} neighbor`,
          description: `${id} neighbor preview.`,
          outputs: [{ type: "file", path: `${id}.txt`, content: `${id}\n` }],
        }),
      )
    }
  await writeFile(
    source,
    JSON.stringify({
      id: "fixture",
      name: "Local team catalog",
      description: Array.from(
        { length: 40 },
        (_, i) => `Catalog preview paragraph ${i + 1}.`,
      ).join("\n\n"),
      kits: [
        ...(neighbors
          ? [{ id: "before", name: "Before neighbor", source: "before.yaml" }]
          : []),
        { id: "team", name: "Team context", source: "kit.yaml" },
        ...(neighbors
          ? [{ id: "after", name: "After neighbor", source: "after.yaml" }]
          : []),
      ],
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
  const input = (id: string) => {
    const node = setup.renderer.root.findDescendantById(`${id}:input`)
    expect(node).toBeInstanceOf(InputRenderable)
    return node as InputRenderable
  }
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
    if (model.selected()?.kind === "input" && model.editing) return
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
    expect(frame()).toContain("Instructions")
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
    input,
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
  test("configures every question type, reviews structured changes, defaults to editing, then deliberately applies once", async () => {
    const ui = await fixture()
    const agents = join(ui.repository, "AGENTS.md")
    await writeFile(agents, "Keep my existing instructions.\n")
    expect(ui.frame()).toContain("◆ Loadout")
    await ui.openKit()
    const teamInput = ui.input("question:source")
    const questionLabel = descendants(
      ui.setup.renderer.root.findDescendantById("question:source")!,
    ).find((node) => node instanceof TextRenderable) as TextRenderable
    expect(questionLabel.plainText.trim()).toBe("Team name")
    expect(teamInput.value).toBe("")
    expect(teamInput.placeholder).toBe("Enter a value")
    expect(teamInput.focused).toBe(false)
    expect(teamInput.x).toBe(questionLabel.x + 2)
    expect(teamInput.y).toBe(questionLabel.y + questionLabel.height)
    const scopeOptions = [0, 1, 2, 3].map(
      (index) =>
        ui.setup.renderer.root.findDescendantById(
          `scope:option:${index}`,
        ) as TextRenderable,
    )
    expect(new Set(scopeOptions.map((option) => option.y)).size).toBe(1)
    expect(scopeOptions[1]!.x).toBeGreaterThan(scopeOptions[0]!.x)
    const help = ui.setup.renderer.root.findDescendantById(
      "scope-description",
    ) as TextRenderable
    expect(help).toBeDefined()
    const helpSpans = ui.setup
      .captureSpans()
      .lines.slice(help.y, help.y + help.height)
      .flatMap((line) => {
        let x = 0
        return line.spans.map((span) => {
          const start = x
          x += span.width
          return { ...span, x: start }
        })
      })
      .filter((span) => span.text.includes("This project only."))
    expect(helpSpans.length).toBeGreaterThan(0)
    const formContent = ui.setup.renderer.root.findDescendantById("scope")!
    const scopeLabel = formContent
      .getChildren()
      .find((node) => node instanceof TextRenderable)!
    expect(helpSpans[0]!.x + helpSpans[0]!.text.search(/\S/)).toBe(scopeLabel.x)
    expect(help.x).toBeLessThan(scopeOptions[0]!.x)
    expect(
      helpSpans.every(
        (span) => (span.attributes & TextAttributes.ITALIC) !== 0,
      ),
    ).toBe(true)
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
      expect(ui.model.form?.scope).toBe(
        scope as "repository" | "global" | "both",
      )
      expect(
        ui.model.selected()?.choices?.find((choice) => choice.value === scope)
          ?.selected,
      ).toBe(true)
      await ui.choose("actions", "accept")
      // Required input prevents staging until we fill it below.
      expect(ui.frame()).toContain("Team name: enter a value")
    }
    expect(new Set(scopeColors).size).toBe(3)
    await ui.choose("scope", "repository")
    expect(ui.model.rows().some((row) => row.id === "question:note")).toBe(
      false,
    )
    await ui.answer("source", "Platform team west")
    expect(ui.input("question:source").value).toBe("Platform team west")
    expect(ui.input("question:source").focused).toBe(false)
    expect(questionLabel.plainText.replace(/^[› ]+/, "")).toBe("Team name")
    for (const [id, text] of [
      ["source", "Name used in generated context."],
      ["style", "Choose the level of detail."],
      ["checks", "Select the checks to include."],
      ["extra", "Enable optional notes."],
    ]) {
      await ui.go(`question:${id}`)
      const row = ui.setup.renderer.root.findDescendantById(`question:${id}`)!
      const description = ui.setup.renderer.root.findDescendantById(
        `question:${id}:description`,
      ) as TextRenderable
      expect(description.plainText).toBe(text!)
      expect(description.fg.equals(RGBA.fromHex("#a1b49f"))).toBe(true)
      const label = row
        .getChildren()
        .find((node) => node instanceof TextRenderable)!
      expect(description.x).toBe(label.x)
      const controls = descendants(row).filter(
        (node) =>
          node instanceof InputRenderable ||
          node.id.startsWith(`question:${id}:option:`),
      )
      expect(description.y).toBeGreaterThanOrEqual(
        Math.max(...controls.map((node) => node.y + node.height)),
      )
      const styled = ui.setup
        .captureSpans()
        .lines.slice(description.y, description.y + description.height)
        .flatMap((line) => line.spans)
        .filter((span) => span.text.includes(text!))
      expect(styled.length).toBeGreaterThan(0)
      expect(
        styled.every((span) => (span.attributes & TextAttributes.ITALIC) !== 0),
      ).toBe(true)
    }
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
    expect(ui.frame()).toContain("Extra note")
    await ui.answer("note", "Review before merging")
    expect(ui.input("question:source").value).toBe("Platform team west")
    expect(ui.input("question:note").value).toBe("Review before merging")
    await ui.choose("actions", "accept")
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
    ui.setup.resize(150, 80)
    await ui.setup.flush()
    await ui.press("TAB")
    expect(ui.frame()).toContain("2 file changes")
    expect(ui.frame()).toContain("Apply changes")
    expect(ui.frame()).toContain("Keep editing")
    expect(ui.model.selected()?.id).toBe("review-actions")
    expect(
      ui.model.selected()?.choices?.[ui.model.selected()!.focusedOptionIndex!]
        ?.value,
    ).toBe("edit")
    const sections = [
      "Staged selections",
      "File changes",
      "Locations",
      "Preservation & safety",
      "How to apply",
    ].map((title) => {
      const heading = descendants(
        ui.setup.renderer.root.findDescendantById("review-preview")!,
      ).find(
        (node) => node instanceof TextRenderable && node.plainText === title,
      ) as TextRenderable
      expect(heading).toBeDefined()
      expect(heading.parent).toBeInstanceOf(BoxRenderable)
      expect((heading.parent as BoxRenderable).border).toBe(true)
      expect(ui.frame()).toContain(title)
      return heading.parent!
    })
    for (let i = 1; i < sections.length; i++)
      expect(sections[i]!.y).toBeGreaterThan(
        sections[i - 1]!.y + sections[i - 1]!.height,
      )
    for (const [label, color] of [
      ["Added: 1", "#bbd4a4"],
      ["Modified: 1", "#98c7e6"],
      ["Removed: 0", "#df9a97"],
    ]) {
      const node = descendants(sections[1]!).find(
        (node) => node instanceof TextRenderable && node.plainText === label,
      ) as TextRenderable
      expect(node.fg.equals(RGBA.fromHex(color!))).toBe(true)
      expect(ui.frame()).toContain(label!)
    }
    const reviewText = descendants(
      ui.setup.renderer.root.findDescendantById("review-preview")!,
    )
      .filter((node) => node instanceof TextRenderable)
      .map((node) => (node as TextRenderable).plainText)
      .join("\n")
    expect(reviewText).toContain("Team name: Platform team west")
    expect(reviewText).toContain("Style: detailed")
    const reviewScope = ui.setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("[repository]"))
    expect(reviewScope?.fg.toInts().join(",")).toBe(scopeColors[0])
    expect(reviewText).toContain(ui.repository)
    expect(reviewText).toContain("other known repositories")
    expect(reviewText).toContain(
      "Conflicting or externally edited files block the apply.",
    )
    const applyCalls = spyOn(ui.service, "apply")
    cleanups.push(async () => {
      applyCalls.mockRestore()
    })
    const firstPlan = ui.model.plan
    await ui.select("change:0")
    expect(ui.frame()).toContain("Keep my existing")
    expect(ui.frame()).toContain("Platform team west")
    const diffNodes = descendants(
      ui.setup.renderer.root.findDescendantById("review-preview")!,
    ).filter((node) => node instanceof TextRenderable) as TextRenderable[]
    expect(
      diffNodes
        .find((node) => node.plainText.startsWith("+ Team: Platform team west"))
        ?.fg.equals(RGBA.fromHex("#bbd4a4")),
    ).toBe(true)
    expect(
      diffNodes
        .find((node) =>
          node.plainText.includes("Keep my existing instructions."),
        )
        ?.fg.equals(RGBA.fromHex("#a1b49f")),
    ).toBe(true)
    await ui.go("change:1")
    expect(ui.frame()).toContain("Review before merging")
    await ui.go("review-actions")
    await ui.press(" ")
    expect(ui.model.page).toBe(1)
    expect(ui.model.drafts.size).toBe(1)
    expect(applyCalls).not.toHaveBeenCalled()
    expect(await readFile(agents, "utf8")).toBe(
      "Keep my existing instructions.\n",
    )
    expect(await Bun.file(join(ui.repository, "notes.txt")).exists()).toBe(
      false,
    )
    await ui.press("TAB")
    expect(ui.model.plan === firstPlan).toBe(false)
    expect(
      ui.model.selected()?.choices?.[ui.model.selected()!.focusedOptionIndex!]
        ?.value,
    ).toBe("edit")
    await ui.choose("review-actions", "apply")
    await ui.setup.waitFor(() =>
      ui.model.message.startsWith("Applied successfully"),
    )
    expect(ui.frame()).toContain("Applied successfully")
    expect(applyCalls).toHaveBeenCalledTimes(1)
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
    await ui.go("register")
    const guideCards = [
      "1 · Browse",
      "2 · Configure",
      "3 · Review & apply",
    ].map((title) => {
      const heading = descendants(ui.setup.renderer.root).find(
        (node) => node instanceof TextRenderable && node.plainText === title,
      )!
      expect(heading).toBeDefined()
      const card = heading.parent as BoxRenderable
      expect(card).toBeInstanceOf(BoxRenderable)
      expect(card.border).toBe(true)
      expect(card.height).toBeLessThan(10)
      expect(card.getChildren().length).toBe(2)
      return card
    })
    expect(guideCards[0]!.parent).toBe(guideCards[2]!.parent)
    expect(guideCards[1]!.y).toBeGreaterThan(
      guideCards[0]!.y + guideCards[0]!.height,
    )
    expect(guideCards[2]!.y).toBeGreaterThan(
      guideCards[1]!.y + guideCards[1]!.height,
    )
    expect(
      descendants(guideCards[2]!).some(
        (node) =>
          node instanceof TextRenderable &&
          node.plainText === "Tab to Review. Confirm to write files.",
      ),
    ).toBe(true)
    expect(ui.frame()).toContain("write files.")
    await ui.select("register")
    expect(ui.frame()).toContain("Catalog JSON path or HTTPS URL")
    expect(ui.input("source").focused).toBe(true)
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
    await ui.press("RETURN")
    expect(ui.model.editing).toBeUndefined()
    expect(ui.frame()).toContain("Team name")
    expect(ui.input("question:source").value).toBe("Discard this text q")
    expect(ui.input("question:source").focused).toBe(false)
    expect(ui.frame()).not.toContain("Exit Loadout?")
    await ui.press("TAB")
    expect(ui.frame()).toContain("Accept or cancel the inline form")
    expect(ui.model.page).toBe(0)
    await ui.choose("actions", "cancel")
    expect(ui.frame()).not.toContain("Install where?")
    expect(ui.model.drafts.size).toBe(0)
    await ui.select("kit:fixture/team")
    expect(ui.frame()).toContain("Team name")
    expect(ui.input("question:source").value).toBe("")
    expect(ui.input("question:source").placeholder).toBe("Enter a value")
    await ui.choose("actions", "accept")
    expect(ui.frame()).toContain("Team name: enter a value")
    await ui.answer("source", "Staged team")
    await ui.choose("actions", "accept")
    await ui.select("kit:fixture/team")
    await ui.choose("scope", "global")
    await ui.choose("actions", "cancel")
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
    const checkHeader = (width: number) => {
      const logo = ui.setup.renderer.root.findDescendantById("loadout-wordmark")
      if (width >= 62) {
        expect(logo).toBeDefined()
        expect(logo!.height).toBe(3)
        expect(logo!.width).toBe(27)
      } else expect(logo).toBeUndefined()
      const brand =
        logo ??
        descendants(ui.setup.renderer.root).find(
          (node) =>
            node instanceof TextRenderable && node.plainText === "LOADOUT",
        )!
      expect(brand).toBeDefined()
      expect(brand.x).toBe(2)
      expect(brand.y).toBe(width >= 62 ? 1 : 2)
      const brandText = brand as TextRenderable
      expect(brandText.plainText).toMatch(/^[\x20-\x7e\n]+$/)
      const brandSpans = ui.setup
        .captureSpans()
        .lines.slice(brand.y, brand.y + brand.height)
        .flatMap((line) => {
          let x = 0
          return line.spans.filter((span) => {
            const start = x
            x += span.width
            return (
              start < brand.x + brand.width &&
              x > brand.x &&
              span.text.trim().length > 0
            )
          })
        })
      expect(brandSpans.length).toBeGreaterThan(0)
      expect(
        brandSpans.every(
          (span) => (span.attributes & TextAttributes.BOLD) === 0,
        ),
      ).toBe(true)
      const lines = ui.frame().split("\n")
      expect(lines[0]!.trim()).toBe("")
      expect(lines[4]!.trim()).toBe("")
      const tabs = ["Catalogs", "Installed", "Review"].map((name) =>
        descendants(ui.setup.renderer.root).find(
          (node) =>
            node instanceof TextRenderable && node.plainText.trim() === name,
        )!,
      )
      for (const tab of tabs) {
        expect(tab.height).toBe(1)
        expect(tab.y).toBe(1)
        expect(tab.x).toBeGreaterThanOrEqual(brand.x + brand.width)
        expect(tab.x + tab.width).toBeLessThanOrEqual(width)
      }
      expect(new Set(tabs.map((tab) => tab.y)).size).toBe(1)
      expect(tabs[1]!.x).toBeGreaterThanOrEqual(tabs[0]!.x + tabs[0]!.width)
      const caption = descendants(ui.setup.renderer.root).find(
        (node) =>
          node instanceof TextRenderable &&
          (node.plainText === "agent context, composed" ||
            node.plainText.endsWith(" staged")),
      )!
      expect(caption.y).toBe(3)
      expect(caption.height).toBe(1)
      expect(caption.x).toBe(tabs[0]!.x)
      expect(caption.y).toBeGreaterThanOrEqual(tabs[0]!.y + tabs[0]!.height + 1)
    }
    checkHeader(110)
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
    checkHeader(64)
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
    await ui.focusOption("actions", "accept")
    expect(ui.frame()).toContain("Accept")
    expect(ui.frame()).toContain("Cancel")
    await ui.press(" ")
    expect(ui.frame()).toContain("Team name: enter a value")
    await ui.go("question:source")
    expect(ui.frame()).toContain("› Team name")
    await ui.answer("source", "Narrow screen team")
    await ui.choose("actions", "accept")
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
    ui.setup.resize(44, 24)
    await ui.setup.flush()
    checkHeader(44)
    expect(ui.frame()).toContain("LOADOUT")
  })

  test("hides cascading questions and excludes their outputs when an ancestor is disabled", async () => {
    const ui = await fixture()
    await ui.openKit()
    await ui.answer("source", "Conditional team")
    await ui.choose("question:extra", true)
    await ui.answer("note", "Needs follow-up")
    expect(ui.frame()).toContain("Follow-up owner")
    await ui.answer("followup", "Release team")
    await ui.choose("question:extra", false)
    expect(ui.model.rows().some((row) => row.id === "question:note")).toBe(
      false,
    )
    expect(ui.model.rows().some((row) => row.id === "question:followup")).toBe(
      false,
    )
    expect(ui.model.rows().some((row) => row.id === "question:followup")).toBe(
      false,
    )
    // The preview must also evaluate the cascade, not stale hidden note values.
    ui.setup.mockInput.pressKey("\u001b[6~")
    await ui.setup.flush()
    expect(ui.frame()).toContain("followup.txt")
    expect(ui.frame()).toContain("Not included")
    await ui.choose("actions", "accept")
    expect(ui.model.drafts.get("fixture/team")?.answers).toEqual({
      source: "Conditional team",
      style: "brief",
      checks: [],
      extra: false,
    })
    await ui.press("TAB")
    await ui.press("TAB")
    expect(ui.frame()).toContain("1 file changes")
    expect(ui.model.plan?.changes.map((change) => change.path)).toEqual([
      join(ui.repository, "AGENTS.md"),
    ])
    await ui.choose("review-actions", "apply")
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

  test("wraps lists but locks navigation and previews inside the active kit on Catalogs and Installed", async () => {
    const ui = await fixture(true, false, true)
    expect(ui.model.selected()?.id).toBe("catalog:loadout")
    await ui.press("k")
    expect(ui.model.selected()?.id).toBe("register")
    await ui.press("j")
    expect(ui.model.selected()?.id).toBe("catalog:loadout")
    await ui.select("catalog:fixture")
    expect(ui.model.selected()?.id).toBe("kit:fixture/before")
    const kitRows = ["before", "team", "after"].map((id) =>
      ui.setup.renderer.root.findDescendantById(`kit:fixture/${id}`)!,
    )
    for (const [index, descriptionText] of [
      "before neighbor preview.",
      "Small deterministic team kit.",
      "after neighbor preview.",
    ].entries()) {
      const row = kitRows[index]!
      const label = row
        .getChildren()
        .find((node) => node instanceof TextRenderable)!
      const description = descendants(row).find(
        (node) =>
          node instanceof TextRenderable && node.plainText === descriptionText,
      ) as TextRenderable
      expect(description).toBeDefined()
      expect(description.y).toBeGreaterThanOrEqual(label.y + label.height)
      expect(description.x).toBe(label.x + 4)
      expect(description.fg.equals(RGBA.fromHex("#a1b49f"))).toBe(true)
      const spans = ui.setup
        .captureSpans()
        .lines.slice(description.y, description.y + description.height)
        .flatMap((line) => line.spans)
        .filter((span) => span.text.includes(descriptionText))
      expect(spans.length).toBeGreaterThan(0)
      expect(
        spans.every((span) => (span.attributes & TextAttributes.ITALIC) !== 0),
      ).toBe(true)
      if (index)
        expect(row.y).toBeGreaterThan(
          kitRows[index - 1]!.y + kitRows[index - 1]!.height,
        )
    }
    await ui.press("k")
    expect(ui.model.selected()?.id).toBe("kit:fixture/after")
    await ui.press("j")
    expect(ui.model.selected()?.id).toBe("kit:fixture/before")
    // Stage in list order so Installed also has neighbors around the active kit.
    await ui.press(" ")
    await ui.choose("actions", "accept")
    await ui.select("kit:fixture/team")
    const formRows = ui.model
      .rows()
      .filter((row) => row.item?.key === "fixture/team")
    for (let index = 1; index < formRows.length; index++) {
      const before = ui.setup.renderer.root.findDescendantById(
        formRows[index - 1]!.id,
      )!
      const current = ui.setup.renderer.root.findDescendantById(
        formRows[index]!.id,
      )!
      expect(current.y).toBeGreaterThan(before.y + before.height)
    }
    const accept = ui.setup.renderer.root.findDescendantById(
      "actions:option:0",
    ) as TextRenderable
    const cancel = ui.setup.renderer.root.findDescendantById(
      "actions:option:1",
    ) as TextRenderable
    expect(accept.plainText).toBe("Accept ")
    expect(cancel.plainText).toBe("Cancel ")
    const contentEdge =
      ui.setup.renderer.root.findDescendantById("scope-description")!.x
    expect(accept.x + accept.plainText.search(/\S/)).toBe(contentEdge)
    const actions = ui.setup.renderer.root.findDescendantById("actions")!
    const followingKit =
      ui.setup.renderer.root.findDescendantById("kit:fixture/after")!
    expect(followingKit.y).toBeGreaterThan(actions.y + actions.height)
    expect(cancel.y).toBe(accept.y)
    expect(cancel.x).toBeGreaterThan(accept.x + accept.width)
    await ui.go("actions")
    await ui.press("l")
    expect(ui.model.selected()?.focusedOptionIndex).toBe(1)
    expect(ui.model.form).toBeDefined()
    await ui.press("h")
    expect(ui.model.selected()?.focusedOptionIndex).toBe(0)
    await ui.press("j")
    expect(ui.model.selected()?.id).toBe("scope")
    await ui.press("j")
    expect(ui.model.selected()?.id).toBe("question:source")
    expect(ui.model.editing).toBeDefined()
    expect(ui.frame()).toContain("Type an answer")
    await ui.setup.mockInput.typeText("hjklqq")
    await ui.setup.flush()
    expect(ui.model.selected()?.id).toBe("question:source")
    expect(ui.model.form?.answers.source).toBe("hjklqq")
    expect(ui.input("question:source").value).toBe("hjklqq")
    expect(ui.frame()).not.toContain("Exit Loadout?")
    await ui.press("RETURN")
    expect(ui.model.editing).toBeUndefined()
    expect(ui.input("question:source").focused).toBe(false)
    expect(ui.input("question:source").value).toBe("hjklqq")
    await ui.press("j")
    expect(ui.model.selected()?.id).toBe("question:style")
    await ui.press("l")
    expect(ui.model.selected()?.focusedOptionIndex).toBe(1)
    expect(ui.model.form?.answers.style).toBe("brief")
    await ui.press(" ")
    expect(ui.model.form?.answers.style).toBe("detailed")
    await ui.press("h")
    await ui.press(" ")
    expect(ui.model.form?.answers.style).toBe("brief")
    await ui.press("k")
    expect(ui.model.editing).toBeDefined()
    await ui.press("ARROW_DOWN")
    expect(ui.model.selected()?.id).toBe("question:style")
    expect(ui.model.editing).toBeUndefined()
    await ui.press("k")
    for (let i = 0; i < 6; i++) ui.setup.mockInput.pressBackspace()
    await ui.press("RETURN")
    expect(ui.model.editing).toBeUndefined()
    await ui.press("k")
    expect(ui.model.selected()?.id).toBe("scope")
    const assertLocked = () => {
      expect(ui.model.selected()?.item?.key).toBe("fixture/team")
      expect(ui.model.selected()?.kind).not.toBe("kit")
      const details = descendants(ui.setup.renderer.root).find(
        (node) => node instanceof BoxRenderable && node.title === "Details",
      )!
      const text = descendants(details)
        .filter((node) => node instanceof TextRenderable)
        .map((node) => (node as TextRenderable).plainText)
        .join("\n")
      expect(text).toContain("Team context")
      expect(text).not.toContain("before neighbor preview.")
      expect(text).not.toContain("after neighbor preview.")
    }
    const wrapForm = async () => {
      await ui.go("scope")
      await ui.press("k")
      expect(ui.model.selected()?.id).toBe("actions")
      assertLocked()
      await ui.press("j")
      expect(ui.model.selected()?.id).toBe("scope")
      const formLength = ui.model
        .rows()
        .filter(
          (row) => row.item?.key === "fixture/team" && row.kind !== "kit",
        ).length
      for (let step = 0; step < formLength; step++) {
        await ui.press("ARROW_DOWN")
        assertLocked()
      }
      expect(ui.model.selected()?.id).toBe("scope")
      for (let step = 0; step < formLength; step++) {
        await ui.press("ARROW_UP")
        assertLocked()
      }
      expect(ui.model.selected()?.id).toBe("scope")
    }
    await wrapForm()
    await ui.go("question:source")
    await ui.press("ESCAPE")
    expect(ui.frame()).toContain("Team name: enter a value")
    expect(ui.model.form).toBeDefined()
    expect(ui.model.drafts.has("fixture/team")).toBe(false)
    expect(await Bun.file(join(ui.repository, "AGENTS.md")).exists()).toBe(
      false,
    )
    await wrapForm()
    await ui.answer("source", "Navigation team")
    await ui.choose("question:extra", true)
    await ui.answer("note", "Needs follow-up")
    expect(ui.model.rows().some((row) => row.id === "question:followup")).toBe(
      true,
    )
    await ui.press("ARROW_DOWN")
    expect(ui.model.selected()?.id).toBe("question:followup")
    expect(ui.model.editing).toBeDefined()
    expect(ui.frame()).toContain("Type an answer")
    await ui.press("ARROW_UP")
    expect(ui.model.selected()?.id).toBe("question:note")
    expect(ui.model.editing).toBeDefined()
    await ui.press("RETURN")
    await ui.choose("question:extra", false)
    expect(
      ui.model
        .rows()
        .some(
          (row) => row.id === "question:note" || row.id === "question:followup",
        ),
    ).toBe(false)
    await wrapForm()
    await ui.press("TAB")
    expect(ui.frame()).toContain("Accept or cancel the inline form")
    expect(ui.model.page).toBe(0)
    await ui.go("question:source")
    await ui.setup.mockInput.typeText(" latest")
    await ui.press("ESCAPE")
    expect(ui.model.form).toBeUndefined()
    expect(ui.model.drafts.get("fixture/team")?.answers.source).toBe(
      "Navigation team latest",
    )
    expect(ui.model.selected()?.id).toBe("kit:fixture/team")
    await ui.press("ARROW_UP")
    expect(ui.model.selected()?.id).toBe("kit:fixture/before")
    await ui.select("kit:fixture/team")
    await ui.choose("actions", "cancel")
    expect(ui.model.selected()?.id).toBe("kit:fixture/team")
    await ui.press("ARROW_DOWN")
    expect(ui.model.selected()?.id).toBe("kit:fixture/after")
    await ui.press(" ")
    await ui.choose("actions", "accept")
    await ui.press("TAB")
    expect(ui.model.rows().map((row) => row.id)).toEqual([
      "kit:fixture/before",
      "kit:fixture/team",
      "kit:fixture/after",
    ])
    await ui.press("ARROW_UP")
    expect(ui.model.selected()?.id).toBe("kit:fixture/after")
    await ui.press("ARROW_DOWN")
    expect(ui.model.selected()?.id).toBe("kit:fixture/before")
    await ui.select("kit:fixture/team")
    await wrapForm()
    await ui.choose("question:extra", true)
    await ui.choose("actions", "accept")
    expect(ui.frame()).toContain("Extra note: enter a value")
    await wrapForm()
    await ui.choose("scope", "none")
    expect(ui.model.rows().some((row) => row.kind === "input")).toBe(false)
    await wrapForm()
    await ui.choose("actions", "cancel")
    expect(ui.model.selected()?.id).toBe("kit:fixture/team")
    await ui.press("ARROW_DOWN")
    expect(ui.model.selected()?.id).toBe("kit:fixture/after")
    await ui.select("kit:fixture/team")
    await ui.choose("scope", "both")
    await ui.focusOption("actions", "cancel")
    await ui.press("ESCAPE")
    expect(ui.model.selected()?.id).toBe("kit:fixture/team")
    expect(ui.model.drafts.get("fixture/team")?.answers.source).toBe(
      "Navigation team latest",
    )
    expect(ui.model.drafts.get("fixture/team")?.scope).toBe("both")
    await ui.press("ARROW_UP")
    expect(ui.model.selected()?.id).toBe("kit:fixture/before")
    expect(ui.frame()).toContain("3 staged")
    expect(ui.service.installed()).toEqual([])
    expect(await Bun.file(join(ui.repository, "AGENTS.md")).exists()).toBe(
      false,
    )
  })

  test("renders live Markdown in separate contribution cards and restores excluded styles when reenabled", async () => {
    const ui = await fixture(true, true)
    const kitPath = join(dirname(ui.source), "kit.yaml")
    const originalKitFile = await readFile(kitPath, "utf8")
    await ui.openKit()
    ui.setup.resize(150, 80)
    await ui.setup.flush()
    const card = (label: string) => {
      const box = descendants(ui.setup.renderer.root).find(
        (node) => node instanceof BoxRenderable && node.title === label,
      ) as BoxRenderable
      expect(box).toBeDefined()
      expect(box.border).toEqual(["top"])
      expect(box.borderStyle).toBe("single")
      expect(box.titleAlignment).toBe("center")
      return { box }
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
    const instructions = card("Instructions")
    expect(instructions.box.borderColor.equals(RGBA.fromHex("#bbd4a4"))).toBe(
      true,
    )
    expect(instructions.box.titleColor?.equals(RGBA.fromHex("#bbd4a4"))).toBe(
      true,
    )
    const file = card("File · notes.txt")
    const skill = card("Skill · team-guide")
    expect(new Set([instructions.box, file.box, skill.box]).size).toBe(3)
    expect(file.box.parent).toBe(instructions.box.parent)
    expect(skill.box.parent).toBe(instructions.box.parent)
    const sections = instructions.box
      .parent!.getChildren()
      .filter(
        (node) => node instanceof BoxRenderable && node.title,
      ) as BoxRenderable[]
    for (let index = 1; index < sections.length; index++) {
      const previous = sections[index - 1]!
      expect(sections[index]!.y).toBe(previous.y + previous.height + 1)
      const gap = ui.frame().split("\n")[previous.y + previous.height]!
      expect(
        Array.from(gap)
          .slice(previous.x, previous.x + previous.width)
          .join("")
          .trim(),
      ).toBe("")
    }
    expect(
      descendants(ui.setup.renderer.root).filter(
        (node) =>
          node instanceof BoxRenderable && node.title === "Instructions",
      ).length,
    ).toBe(1)
    expect(
      descendants(instructions.box).filter(
        (node) => node instanceof MarkdownRenderable,
      ).length,
    ).toBe(2)
    const heading = descendants(ui.setup.renderer.root).find(
      (node) =>
        node instanceof TextRenderable &&
        node.plainText === "Team context * fixture/team",
    ) as TextRenderable
    expect(heading).toBeDefined()
    const headerSpans = ui.setup
      .captureSpans()
      .lines.slice(heading.y, heading.y + heading.height)
      .flatMap((line) => line.spans)
    const nameSpan = headerSpans.find((span) => span.text === "Team context")!
    const idSpan = headerSpans.find((span) =>
      span.text.includes("* fixture/team"),
    )!
    expect(nameSpan.fg.equals(RGBA.fromHex("#bbd4a4"))).toBe(true)
    expect(nameSpan.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
    expect(idSpan.fg.equals(RGBA.fromHex("#a1b49f"))).toBe(true)
    expect(idSpan.attributes & TextAttributes.BOLD).toBe(0)
    expect(
      descendants(skill.box).some(
        (node) =>
          node instanceof TextRenderable &&
          node.plainText === "references/checklist.md",
      ),
    ).toBe(true)
    expect(ui.frame()).toContain("Checklist for {{source}}.")

    for (const width of [110, 64]) {
      ui.setup.resize(width, 120)
      await ui.setup.flush()
      const frame = ui
        .frame()
        .split("\n")
        .map((line) => Array.from(line))
      for (const [box, sequence] of [
        [card("Instructions").box, proseRun],
        [card("Skill · team-guide").box, codeRun],
      ] as const) {
        const details = descendants(ui.setup.renderer.root).find(
          (node) => node instanceof BoxRenderable && node.title === "Details",
        )!
        const lines = frame.slice(box.y + 1, box.y + box.height)
        const right = box.x + box.width
        const outerRight = details.x + details.width - 1
        expect(lines.length).toBe(box.height - 1)
        for (const line of lines) {
          expect(line[details.x]).toBe("│")
          expect(line[outerRight]).toBe("│")
          const visibleColumns = line
            .slice(details.x + 1, outerRight)
            .flatMap((char, index) =>
              char.trim() ? [details.x + 1 + index] : [],
            )
          if (visibleColumns.length) {
            expect(Math.min(...visibleColumns)).toBeGreaterThanOrEqual(box.x)
            expect(Math.max(...visibleColumns)).toBeLessThan(right)
          }
        }
        const visible = lines
          .map((line) => line.slice(box.x, right).join("").trim())
          .join("")
        expect(visible).toContain(sequence)
      }
    }
    ui.setup.resize(150, 80)
    await ui.setup.flush()

    const documents = () => ({
      instructions: descendants(card("Instructions").box).find(
        (node) => node instanceof MarkdownRenderable,
      )!,
      skill: descendants(card("Skill · team-guide").box).find(
        (node) => node instanceof MarkdownRenderable,
      )!,
      optional: descendants(card("Instructions").box).find(
        (node) =>
          node instanceof MarkdownRenderable &&
          node.content.startsWith("## Optional context"),
      )!,
    })
    const metadata = () =>
      descendants(card("Skill · team-guide").box).find(
        (node) =>
          node instanceof TextRenderable &&
          node.plainText.startsWith("name: team-guide\n"),
      ) as TextRenderable
    expect(metadata()).toBeInstanceOf(TextRenderable)
    expect(metadata().plainText).toBe(
      "name: team-guide\ndescription: Guide for {{source}}.",
    )
    expect(metadata().y + metadata().height).toBeLessThan(documents().skill.y)
    expect(
      (documents().skill as MarkdownRenderable).content.startsWith("# Runbook"),
    ).toBe(true)

    await ui.select("question:source")
    await ui.setup.mockInput.typeText("Alpha")
    await ui.setup.flush()
    expect(ui.frame()).toContain("Owner: Alpha")
    expect(ui.frame()).toContain("description: Guide for Alpha.")
    const stableMetadata = metadata()
    const stable = documents()
    expect(stable.instructions).toBeInstanceOf(MarkdownRenderable)
    expect(stable.skill).toBeInstanceOf(MarkdownRenderable)
    expect(stable.optional).toBeInstanceOf(MarkdownRenderable)
    const paragraphs = {
      instructions: stable.instructions
        .getChildren()
        .filter((node) => node instanceof CodeRenderable),
      skill: stable.skill
        .getChildren()
        .filter((node) => node instanceof CodeRenderable),
      optional: stable.optional
        .getChildren()
        .filter((node) => node instanceof CodeRenderable),
    }
    expect(paragraphs.instructions.length).toBeGreaterThan(1)
    expect(paragraphs.skill.length).toBeGreaterThan(1)
    const expectRetained = () => {
      expect(metadata() === stableMetadata).toBe(true)
      expect(card("Instructions").box === instructions.box).toBe(true)
      expect(card("Skill · team-guide").box === skill.box).toBe(true)
      expect(metadata().plainText).toBe(
        `name: team-guide\ndescription: Guide for ${ui.input("question:source").value}.`,
      )
      expect(ui.frame()).toContain(
        `description: Guide for ${ui.input("question:source").value}.`,
      )
      const current = documents()
      for (const key of ["instructions", "skill", "optional"] as const) {
        if (current[key] !== stable[key])
          throw new Error(`${key} Markdown document was replaced`)
        const blocks = current[key]
          .getChildren()
          .filter((node) => node instanceof CodeRenderable)
        expect(blocks.length).toBe(paragraphs[key].length)
        if (!blocks.every((block, index) => block === paragraphs[key][index])) {
          throw new Error(
            `${key} Markdown paragraphs were replaced: ${paragraphs[key].map((node) => node.id).join(", ")} -> ${blocks.map((node) => node.id).join(", ")}`,
          )
        }
      }
    }
    const bounds = {
      x: instructions.box.x,
      y: instructions.box.y,
      width: instructions.box.width,
      height: instructions.box.height,
    }
    const previewGeometry = paragraphs.instructions.map((node) => [
      node.x,
      node.y,
      node.width,
      node.height,
    ])
    const recorder = new TestRecorder(ui.setup.renderer)
    recorder.rec()
    try {
      // Record every actual native render pass, including intermediate frames,
      // rather than checking only the settled frame after the whole answer.
      for (const character of " team") {
        await ui.setup.mockInput.typeText(character)
        await ui.setup.flush()
        expectRetained()
        expect(
          paragraphs.instructions.map((node) => [
            node.x,
            node.y,
            node.width,
            node.height,
          ]),
        ).toEqual(previewGeometry)
      }
    } finally {
      recorder.stop()
    }
    expect(recorder.recordedFrames.length).toBeGreaterThan(0)
    let previousOwner = "Alpha"
    for (const { frame } of recorder.recordedFrames) {
      const contribution = frame
        .split("\n")
        .slice(bounds.y, bounds.y + bounds.height)
        .map((line) =>
          Array.from(line)
            .slice(bounds.x, bounds.x + bounds.width)
            .join(""),
        )
        .join("\n")
      expect(contribution).toContain("Team charter")
      expect(contribution).toContain("Style: brief")
      const owner = /Owner: (Alpha[a-z ]*)/.exec(contribution)?.[1]?.trimEnd()
      expect(owner).toBeDefined()
      expect(owner!.startsWith(previousOwner)).toBe(true)
      expect("Alpha team".startsWith(owner!)).toBe(true)
      previousOwner = owner!
    }
    expect(previousOwner).toBe("Alpha team")
    expect(ui.input("question:source").value).toBe("Alpha team")
    expect(ui.frame()).toContain("Owner: Alpha team")
    for (let i = 0; i < 5; i++) ui.setup.mockInput.pressBackspace()
    await ui.setup.flush()
    expect(ui.frame()).toContain("Owner: Alpha")
    const headingSpan = spansIn(card("Instructions").box).find((span) =>
      span.text.includes("Team charter"),
    )
    expect(headingSpan).toBeDefined()
    expect(headingSpan!.attributes & TextAttributes.BOLD).toBe(0)
    expect(headingSpan!.fg.equals(RGBA.fromHex("#bbd4a4"))).toBe(true)
    const renderedHeading = descendants(documents().instructions).find(
      (node) =>
        node instanceof TextBufferRenderable &&
        node.plainText === "# Team charter",
    )!
    expect(renderedHeading).toBeDefined()
    expect(renderedHeading.height).toBe(1)
    expect(ui.frame()).toContain("# Team charter")
    const strongSpan = spansIn(card("Instructions").box).find((span) =>
      span.text.includes("Owner"),
    )
    expect(strongSpan).toBeDefined()
    expect(strongSpan!.attributes & TextAttributes.BOLD).toBe(
      TextAttributes.BOLD,
    )
    expect(ui.frame()).not.toContain("**Owner**")
    for (let i = 0; i < 5; i++) ui.setup.mockInput.pressBackspace()
    await ui.setup.mockInput.typeText("Beta")
    await ui.setup.flush()
    expect(ui.frame()).toContain("Owner: Beta")
    expect(ui.frame()).not.toContain("Owner: Alpha")
    expectRetained()
    await ui.press("RETURN")

    const expectStable = () => {
      expectRetained()
      expect(ui.frame()).toContain("Owner: Beta")
    }
    await ui.focusOption("question:style", "detailed")
    expectStable()
    await ui.focusOption("question:style", "brief")
    expectStable()
    await ui.choose("scope", "both")
    expectStable()
    await ui.choose("scope", "repository")
    expectStable()
    await ui.choose("question:unrelated", true)
    expectStable()
    await ui.answer("scratch", "Not used in any contribution")
    expectStable()
    await ui.choose("question:style", "detailed")
    expectRetained()
    expect(ui.frame()).toContain("Style: detailed")
    expect(ui.frame()).toContain("Owner: Beta")

    const checkExcluded = (excluded: boolean) => {
      expectRetained()
      const gray = RGBA.fromHex("#858b87")
      const instructionSection = card("Instructions").box
      const fragment = (document: Renderable) => {
        let node = document
        while (node.parent && node.parent !== instructionSection)
          node = node.parent
        return node
      }
      const primaryFragment = fragment(documents().instructions)
      const optionalFragment = fragment(documents().optional)
      expect(optionalFragment.y).toBe(
        primaryFragment.y + primaryFragment.height + 1,
      )
      const fragmentGap = ui.frame().split("\n")[
        primaryFragment.y + primaryFragment.height
      ]!
      expect(
        Array.from(fragmentGap)
          .slice(
            instructionSection.x,
            instructionSection.x + instructionSection.width,
          )
          .join("")
          .trim(),
      ).toBe("")
      expect(
        instructionSection.titleColor?.equals(RGBA.fromHex("#bbd4a4")),
      ).toBe(true)
      const optionalHeading = descendants(documents().optional).find(
        (node) =>
          node instanceof TextBufferRenderable &&
          node.plainText === "## Optional context",
      )!
      expect(optionalHeading).toBeDefined()
      expect(optionalHeading.height).toBe(1)
      const optionalSpans = spansIn(instructionSection).filter(
        (span) =>
          span.text.includes("## Optional context") ||
          span.text.includes("Additional guidance for Beta."),
      )
      expect(optionalSpans.length).toBeGreaterThanOrEqual(2)
      expect(
        optionalSpans.every((span) =>
          span.fg.equals(
            excluded
              ? gray
              : RGBA.fromHex(
                  span.text.includes("## Optional context")
                    ? "#bbd4a4"
                    : "#e1eadc",
                ),
          ),
        ),
      ).toBe(true)
      const optionalHeadingSpan = optionalSpans.find((span) =>
        span.text.includes("## Optional context"),
      )!
      expect(optionalHeadingSpan.attributes & TextAttributes.BOLD).toBe(0)
      const primaryHeading = spansIn(instructionSection).find((span) =>
        span.text.includes("# Team charter"),
      )!
      expect(primaryHeading.fg.equals(RGBA.fromHex("#bbd4a4"))).toBe(true)
      expect(ui.frame()).toContain("Additional guidance for Beta.")
      for (const label of ["File · notes.txt", "Skill · team-guide"]) {
        const current = card(label)
        expect(current.box.borderColor.equals(gray)).toBe(excluded)
        expect(current.box.titleColor?.equals(gray)).toBe(excluded)
        const titleSpans = ui.setup
          .captureSpans()
          .lines[current.box.y]!.spans.filter((span) =>
            span.text.includes(label),
          )
        expect(titleSpans.length).toBeGreaterThan(0)
        expect(titleSpans.every((span) => span.fg.equals(gray))).toBe(excluded)
        if (!excluded)
          expect(
            current.box.titleColor?.equals(
              RGBA.fromHex(label.startsWith("Skill") ? "#c4ace0" : "#98c7e6"),
            ),
          ).toBe(true)
        const body = spansIn(current.box).filter((span) =>
          span.text.includes(
            label.startsWith("Skill") ? "Runbook" : "{{note}}",
          ),
        )
        expect(body.length).toBeGreaterThan(0)
        expect(body.every((span) => span.fg.equals(gray))).toBe(excluded)
        if (label.startsWith("Skill")) {
          const metadataSpans = spansIn(current.box).filter(
            (span) =>
              span.text.includes("name: team-guide") ||
              span.text.includes("Guide for Beta."),
          )
          expect(metadataSpans.length).toBeGreaterThanOrEqual(2)
          const metadataColor = RGBA.fromHex(excluded ? "#858b87" : "#a1b49f")
          expect(metadata().fg.equals(metadataColor)).toBe(true)
          expect(
            metadataSpans.every(
              (span) =>
                span.fg.equals(metadataColor) &&
                (span.attributes & TextAttributes.BOLD) === 0,
            ),
          ).toBe(true)
          const liveAnswer = spansIn(current.box).filter((span) =>
            span.text.includes("Beta"),
          )
          expect(liveAnswer.length).toBeGreaterThan(0)
          expect(liveAnswer.every((span) => span.fg.equals(gray))).toBe(
            excluded,
          )
          // Markdown creates distinct code/rule children. Their colors must
          // update too, not only the containing markdown's foreground.
          const code = descendants(documents().skill).find(
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
          const rule = descendants(documents().skill).find(
            (node) =>
              node instanceof BoxRenderable &&
              Array.isArray(node.border) &&
              node.border.length === 1 &&
              node.border[0] === "top",
          ) as BoxRenderable | undefined
          expect(rule).toBeDefined()
          expect(rule!.y).toBeGreaterThanOrEqual(code!.y + code!.height)
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
    ui.setup.resize(150, 80)
    await ui.setup.flush()
    await ui.press("\u001b[5~")
    expect(ui.frame()).toContain("Owner: Beta")
    checkExcluded(true)
    await ui.choose("question:extra", true)
    checkExcluded(false)
    expect(ui.frame()).toContain("Checklist for Beta.")
    expect(ui.model.drafts.size).toBe(0)
    // One preview card still represents both configured instruction targets.
    const skillOutput = ui.model.catalog?.kits
      .find((item) => item.key === "fixture/team")
      ?.kit.outputs.find((output) => output.type === "skill")
    expect(skillOutput?.type === "skill" && skillOutput.files["SKILL.md"]).toBe(
      skillDocument,
    )
    expect(await readFile(kitPath, "utf8")).toBe(originalKitFile)
    await ui.choose("question:extra", false)
    await ui.press("ESCAPE")
    await ui.press("TAB")
    await ui.press("TAB")
    expect(ui.model.plan?.changes.map((change) => change.path).sort()).toEqual([
      join(ui.repository, "AGENTS.md"),
      join(ui.repository, "CLAUDE.md"),
    ])
    expect(await Bun.file(join(ui.repository, "AGENTS.md")).exists()).toBe(
      false,
    )
    expect(await Bun.file(join(ui.repository, "CLAUDE.md")).exists()).toBe(
      false,
    )
  })
})
