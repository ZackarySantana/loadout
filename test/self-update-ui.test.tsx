import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { testRender } from "@opentui/solid"
import { LoadoutService } from "../src/backend/service"
import type { LoadedKit } from "../src/domain/kit"
import type {
  SelfUpdateAvailability,
  UpdateInstaller,
} from "../src/domain/self-update"
import { App } from "../src/frontend/App"
import { ScreenModel } from "../src/frontend/model"
import { hasPendingSelfUpdateWork } from "../src/frontend/self-update-client"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const notice = { currentVersion: "0.5.1", latestVersion: "0.6.0-beta.2+review" }
const item: LoadedKit = {
  key: "fixture/team",
  kit: {
    id: "team",
    name: "Team",
    description: "Minimal pending-work fixture",
    questions: [{ id: "owner", type: "input", label: "Owner", required: true }],
    outputs: [{ type: "file", path: "team.txt", content: "{{owner}}" }],
  },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function files(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      for (const [name, content] of Object.entries(await files(path)))
        result[join(entry.name, name)] = content
    } else result[entry.name] = (await readFile(path)).toString("base64")
  }
  return result
}

async function fixture(
  options: {
    discover?: (signal?: AbortSignal) => Promise<SelfUpdateAvailability>
    confirm?: NonNullable<Parameters<typeof App>[0]["onAppUpdateConfirm"]>
  } = {},
) {
  const root = await mkdtemp("/tmp/opencode/loadout-update-ui-")
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const home = join(root, "home")
  const repository = join(root, "repo")
  await Promise.all([home, repository].map((path) => mkdir(path)))
  const service = await LoadoutService.open({
    home,
    repository,
    environment: {},
  })
  const model = new ScreenModel(service)
  await model.initialize()
  const discover = mock(
    options.discover ??
      (async () => ({ installers: ["mise", "npm"] as UpdateInstaller[] })),
  )
  const confirm = mock(options.confirm ?? (async () => {}))
  const exit = mock(() => {})
  const setup = await testRender(
    () => (
      <App
        model={model}
        onExit={exit}
        appUpdate={notice}
        onAppUpdateDiscover={discover}
        onAppUpdateConfirm={confirm}
      />
    ),
    { width: 110, height: 40, kittyKeyboard: true },
  )
  cleanups.push(async () => {
    setup.renderer.destroy()
    await setup.renderer.closed
  })
  await setup.flush()
  const press = async (key: string) => {
    setup.mockInput.pressKey(key)
    await setup.flush()
  }
  const frame = () => setup.captureCharFrame()
  const choose = async (installer: UpdateInstaller = "npm") => {
    await press("u")
    expect(frame()).toContain("Choose a verified owner")
    await press("ARROW_RIGHT")
    if (installer === "npm") await press("ARROW_RIGHT")
    await press("RETURN")
    expect(frame()).toContain("Confirm application update")
    expect(confirm).not.toHaveBeenCalled()
  }
  return {
    ...setup,
    model,
    discover,
    confirm,
    exit,
    press,
    frame,
    choose,
    disk: () => files(root),
  }
}

function pendingSnapshot(model: ScreenModel) {
  return structuredClone({
    drafts: [...model.drafts],
    settingsDraft: model.settingsDraft,
    savedSettings: model.savedSettings,
    stagedSettingsGroups: [...model.stagedSettingsGroups],
    form: model.form,
    settingsForm: model.settingsForm,
    catalogRefreshForm: model.catalogRefreshForm,
    editing: model.editing,
    registering: model.registering,
    source: model.source,
    busy: model.busy,
    catalogProgress: model.catalogProgress,
  })
}

const pendingCases: [string, (model: ScreenModel) => void][] = [
  [
    "kit draft",
    (model) => {
      model.drafts.set(item.key, {
        item,
        scope: "both",
        answers: { owner: "Keep draft" },
      })
    },
  ],
  [
    "settings draft",
    (model) => {
      model.settingsDraft = structuredClone(model.savedSettings!)
      model.settingsDraft.repositoryInstructions.locations = ["KEEP.md"]
      model.stagedSettingsGroups.add("repositoryInstructions")
    },
  ],
  [
    "kit form",
    (model) => {
      model.form = {
        item,
        scope: "repository",
        answers: { owner: "Keep form" },
      }
    },
  ],
  [
    "settings form",
    (model) => {
      model.settingsForm = {
        group: "repositoryInstructions",
        locations: [{ id: "keep", value: "KEEP.md" }],
        mode: "copy",
        ignore: "none",
      }
    },
  ],
  [
    "catalog refresh form",
    (model) => {
      model.catalogRefreshForm = { catalog: model.catalogs[0]!, update: true }
    },
  ],
  [
    "answer editing",
    (model) => {
      model.editing = { kind: "question", id: "owner" }
    },
  ],
  [
    "catalog registration",
    (model) => {
      model.registering = true
      model.source = "Keep this unfinished source"
    },
  ],
  [
    "busy operation",
    (model) => {
      model.busy = true
    },
  ],
  [
    "catalog progress",
    (model) => {
      model.catalogProgress = {
        source: "fixture",
        stage: "loading",
        completed: 0,
        total: 1,
      }
    },
  ],
]

describe("mocked application updater UI", () => {
  test("notice, Later and reopening do not discover; only explicit Update does", async () => {
    const f = await fixture()
    expect(f.frame()).toContain("Update available")
    expect(f.discover).not.toHaveBeenCalled()
    await f.press("RETURN")
    expect(f.frame()).not.toContain("Update available")
    await f.press("u")
    expect(f.frame()).toContain("Update available")
    expect(f.discover).not.toHaveBeenCalled()
    await f.press("ARROW_RIGHT")
    await f.press("RETURN")
    expect(f.discover).toHaveBeenCalledTimes(1)
    expect(f.discover.mock.calls[0]![0]).toBeInstanceOf(AbortSignal)
    expect(f.frame()).toContain("Choose a verified owner")
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.exit).not.toHaveBeenCalled()
  })

  test.each(["mise", "npm"] as const)(
    "selecting %s only reviews; explicit y confirms the exact selection",
    async (installer) => {
      const f = await fixture()
      const before = await f.disk()
      await f.choose(installer)
      expect(f.frame()).toContain(notice.latestVersion)
      expect(f.frame()).toContain(
        installer === "mise" ? "mise use --global" : "npm install --global",
      )
      expect(f.frame()).toContain("rollback is promised")
      await f.press("y")
      expect(f.confirm).toHaveBeenCalledTimes(1)
      const [selection, canProceed, signal] = f.confirm.mock.calls[0]!
      expect(selection).toEqual({ installer, version: notice.latestVersion })
      expect(canProceed()).toBe(true)
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal!.aborted).toBe(false)
      expect(f.exit).not.toHaveBeenCalled()
      expect(await f.disk()).toEqual(before)
    },
  )

  test.each(["RETURN", "ESCAPE", " "])(
    "confirmation %s cancels rather than invoking the callback",
    async (key) => {
      const f = await fixture()
      await f.choose()
      await f.press(key)
      expect(f.frame()).not.toContain("Confirm application update")
      expect(f.confirm).not.toHaveBeenCalled()
      expect(f.exit).not.toHaveBeenCalled()
    },
  )

  test("Enter still cancels after focusing Confirm update", async () => {
    const f = await fixture()
    await f.choose()
    await f.press("ARROW_RIGHT")
    await f.press("RETURN")
    expect(f.frame()).not.toContain("Confirm application update")
    expect(f.confirm).not.toHaveBeenCalled()
  })

  test.each(pendingCases)(
    "%s appearing after discovery blocks final confirmation without losing data",
    async (_name, change) => {
      const f = await fixture()
      await f.choose()
      change(f.model)
      const before = pendingSnapshot(f.model)
      const disk = await f.disk()
      await f.press("y")
      expect(f.confirm).not.toHaveBeenCalled()
      // Busy operations own keyboard input before the popup handler runs.
      expect(f.frame()).toContain(
        f.model.busy
          ? "Confirm application update"
          : "Finish or cancel open work",
      )
      expect(pendingSnapshot(f.model)).toEqual(before)
      expect(await f.disk()).toEqual(disk)
      expect(f.exit).not.toHaveBeenCalled()
    },
  )

  test("staged kit and settings changes block discovery and survive cancellation", async () => {
    const f = await fixture()
    pendingCases[0]![1](f.model)
    pendingCases[1]![1](f.model)
    const before = pendingSnapshot(f.model)
    const disk = await f.disk()
    await f.press("u")
    expect(f.discover).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.frame()).toContain("Finish or cancel open work")
    await f.press("ESCAPE")
    expect(pendingSnapshot(f.model)).toEqual(before)
    expect(await f.disk()).toEqual(disk)
  })

  test("changes arriving during discovery prevent entering installer selection", async () => {
    const discovery = deferred<SelfUpdateAvailability>()
    const f = await fixture({ discover: () => discovery.promise })
    await f.press("u")
    expect(f.frame()).toContain("Checking supported installer")
    pendingCases[0]![1](f.model)
    pendingCases[1]![1](f.model)
    const before = pendingSnapshot(f.model)
    discovery.resolve({ installers: ["npm"] })
    await f.flush()
    expect(f.frame()).toContain("Finish or cancel open work")
    expect(f.frame()).not.toContain("Choose a verified owner")
    expect(f.confirm).not.toHaveBeenCalled()
    expect(pendingSnapshot(f.model)).toEqual(before)
  })

  test("new work after discovery blocks installer selection without clearing it", async () => {
    const f = await fixture()
    await f.press("u")
    expect(f.frame()).toContain("Choose a verified owner")
    pendingCases[0]![1](f.model)
    pendingCases[1]![1](f.model)
    const before = pendingSnapshot(f.model)
    await f.press("ARROW_RIGHT")
    await f.press("RETURN")
    expect(f.frame()).toContain("Finish or cancel open work")
    expect(f.frame()).not.toContain("Confirm application update")
    expect(f.confirm).not.toHaveBeenCalled()
    expect(pendingSnapshot(f.model)).toEqual(before)
  })

  test("cancelled discovery ignores a late result", async () => {
    const discovery = deferred<SelfUpdateAvailability>()
    const f = await fixture({ discover: () => discovery.promise })
    await f.press("u")
    const signal = f.discover.mock.calls[0]![0]!
    await f.press("ESCAPE")
    expect(signal.aborted).toBe(true)
    discovery.resolve({ installers: ["npm"] })
    await f.flush()
    expect(f.frame()).not.toContain("Choose a verified owner")
    expect(f.confirm).not.toHaveBeenCalled()
  })

  test("confirmation continuation rechecks new work and cancellation", async () => {
    const accepted = deferred<void>()
    const f = await fixture({ confirm: () => accepted.promise })
    await f.choose()
    await f.press("y")
    await f.press("y")
    expect(f.confirm).toHaveBeenCalledTimes(1)
    const [, canProceed, signal] = f.confirm.mock.calls[0]!
    expect(canProceed()).toBe(true)
    pendingCases[0]![1](f.model)
    const before = pendingSnapshot(f.model)
    expect(canProceed()).toBe(false)
    await f.press("ESCAPE")
    expect(signal!.aborted).toBe(true)
    expect(canProceed()).toBe(false)
    accepted.resolve()
    await f.flush()
    expect(f.confirm).toHaveBeenCalledTimes(1)
    expect(pendingSnapshot(f.model)).toEqual(before)
    expect(f.exit).not.toHaveBeenCalled()
  })
})

describe("shared pending-work guard", () => {
  const idle = () => ({
    stagedCount: () => 0,
    settingsChanged: () => false,
    registering: false,
    busy: false,
  })
  test("idle permits updating; each independent model guard blocks it", () => {
    expect(hasPendingSelfUpdateWork(idle())).toBe(false)
    const guards = {
      stagedCount: () => 1,
      settingsChanged: () => true,
      form: {},
      settingsForm: {},
      catalogRefreshForm: {},
      editing: {},
      registering: true,
      busy: true,
      catalogProgress: {},
    }
    for (const [key, value] of Object.entries(guards))
      expect(hasPendingSelfUpdateWork({ ...idle(), [key]: value })).toBe(true)
  })

  test("walkthrough, preference save, exit prompt and shutdown independently block updating", () => {
    for (const key of [
      "walkthrough",
      "savingPreference",
      "exitPrompt",
      "shuttingDown",
    ] as const)
      expect(hasPendingSelfUpdateWork(idle(), { [key]: true })).toBe(true)
  })
})
