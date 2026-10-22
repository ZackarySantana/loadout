#!/usr/bin/env -S node --experimental-ffi
import { homedir } from "node:os"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { CliRenderEvents, createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { createSignal } from "solid-js"
import { checkForAppUpdate, dismissAppUpdate } from "./backend/app-updates"
import { isAppVersion, type AppUpdateNotice } from "./domain/app-update"
import { LoadoutService } from "./backend/service"
import { ScreenModel } from "./frontend/model"
import { App } from "./frontend/App"
import { displayKitKey } from "./domain/catalog"
import { SELF_UPDATE_EXIT_CODE } from "./domain/self-update"
import {
  closeSelfUpdateRenderer,
  completeSelfUpdateHandoff,
  createSelfUpdateClient,
  hasPendingSelfUpdateWork,
} from "./frontend/self-update-client"
import { readPreferences, dismissWalkthrough } from "./backend/preferences"
import {
  agentGuide,
  applyWorkflow,
  inspectWorkflow,
  planWorkflow,
  readWorkflowRequest,
} from "./backend/agent-workflow"

declare const LOADOUT_BUNDLED: boolean

const plain = (value: string) =>
  value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      request: { type: "string" },
      catalog: { type: "string" },
      fresh: { type: "boolean" },
      "review-token": { type: "string" },
      approve: { type: "boolean" },
      walkthrough: { type: "boolean" },
    },
  })
  if (values.help) {
    console.log(`Loadout · compose agent instructions and skills

Usage: loadout [--repo <project>] [--walkthrough]
       loadout catalog list
       loadout catalog add <catalog/descriptor path, HTTPS URL or GitHub directory URL>
       loadout catalog remove <registered source>
        loadout status
        loadout guide
        loadout inspect --json [--fresh] [--request FILE] [--catalog SOURCE_OR_ID]
        loadout plan --request FILE --json
        loadout apply --request FILE --review-token SHA256 --approve --json

Agent workflow: guide and inspect first; ask human preferences and visible kit questions.
Remote catalog headers are lazy; inspect --catalog SOURCE_OR_ID discovers their full inventory.
Discovery may use cached inventory; inspect --fresh checks browsed/installed sources live.
Status and catalog-selected plan/apply perform live checks automatically.
Plan prints exact before/after files, links and warnings without applying.
Apply rebuilds and requires the unchanged review token plus explicit human approval.
--approve attests to approval of that exact review; agents must never self-confirm.
Requests are bounded JSON; see guide and inspect.protocol. No --yes shortcut.
Use --repo PATH with any command. External registration requires separate consent.
--walkthrough replays the interactive welcome guide; ? replays it in the TUI.
Set LOADOUT_NO_UPDATE_CHECK=1 to disable background application-version checks.

Tab switches pages. Up/Down or j/k navigate; Left/Right or h/l navigate options.
Text questions start editing on focus; Vim keys then type normally.
Space selects. Esc accepts an open kit; otherwise it goes back. Press q twice to exit.
Kit and settings changes are written only after review and explicit confirmation.
Repo kits are discovered automatically from .loadout/kits/*.yaml; no repo catalog index or registration is needed.
Registration is only for external catalogs and installs no kits.
Discovery/status may write derived remote caches, not installation intent.
Status is read-only; a nonzero exit code means drift or catalog issues were found.`)
    return
  }
  const command = positionals[0]
  if (values.fresh !== undefined && command !== "inspect")
    throw new Error(
      "--fresh is only supported by inspect; status, plan and apply check live automatically",
    )
  if (
    values.catalog !== undefined &&
    (command !== "inspect" || !values.catalog.trim())
  )
    throw new Error("--catalog SOURCE_OR_ID is only supported by inspect")
  if (
    positionals.length &&
    !["guide", "inspect", "plan", "apply", "status", "catalog"].includes(
      command!,
    )
  )
    throw new Error("Unknown command. Use --help for usage.")
  if (command === "status" && positionals.length !== 1)
    throw new Error("status takes no positional arguments")
  if (command === "guide" && positionals.length !== 1)
    throw new Error("guide takes no positional arguments")
  if (
    command === "catalog" &&
    !(
      (positionals[1] === "list" && positionals.length === 2) ||
      (["add", "remove"].includes(positionals[1] ?? "") &&
        positionals.length === 3)
    )
  )
    throw new Error(
      "Use: loadout catalog list | add <source> | remove <source>",
    )
  if (values.walkthrough && positionals.length)
    throw new Error(
      "--walkthrough is only for interactive startup without a command",
    )
  if (command === "guide" && positionals.length === 1) {
    if (
      values.request ||
      values.json ||
      values["review-token"] ||
      values.approve
    )
      throw new Error(
        "guide takes only --repo (optional); use inspect --json for the protocol",
      )
    console.log(agentGuide)
    return
  }
  const machine =
    command === "inspect" || command === "plan" || command === "apply"
  if (machine) {
    if (positionals.length !== 1 || !values.json)
      throw new Error(
        "Use --json and no positional arguments for inspect, plan or apply",
      )
    if (command !== "inspect" && !values.request)
      throw new Error("Supply --request FILE")
    if (
      command === "apply"
        ? !values.approve || !values["review-token"]
        : values.approve || values["review-token"]
    )
      throw new Error(
        "Only apply accepts (and requires) --approve and --review-token SHA256 after human review",
      )
  } else if (
    values.json ||
    values.request ||
    values["review-token"] ||
    values.approve
  ) {
    throw new Error(
      "Agent workflow options require inspect, plan or apply; use guide",
    )
  }
  if (!positionals.length && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Error(
      "The TUI requires an interactive terminal. Use guide or inspect --json for agent-assisted setup.",
    )
  // Parse requests before opening the service: malformed input cannot trigger recovery.
  const request = values.request
    ? await readWorkflowRequest(values.request)
    : undefined
  const service = await LoadoutService.open({
    home: homedir(),
    repository: resolve(values.repo ?? process.cwd()),
  })
  if (machine) {
    const result =
      command === "inspect"
        ? await inspectWorkflow(service, request, values.catalog, {
            fresh: values.fresh,
          })
        : command === "plan"
          ? (await planWorkflow(service, request!)).review
          : await applyWorkflow(service, request!, values["review-token"]!)
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (positionals[0] === "status" && positionals.length === 1) {
    const { drift, errors } = await service.status({ fresh: true })
    const kits = drift.kits.filter((kit) => kit.status !== "current")
    const files = drift.files.filter((file) => file.status !== "current")
    if (!kits.length && !files.length && !errors.length)
      console.log("No drift detected.")
    for (const kit of kits) {
      console.log(
        plain(
          `Kit ${displayKitKey(kit.key)} [${kit.scope}] · ${kit.status}\n  ${kit.reason}`,
        ),
      )
      if (kit.origin?.source)
        console.log(plain(`  Source: ${kit.origin.source}`))
      if (kit.currentIdentity || kit.latestIdentity)
        console.log(
          plain(
            `  Content: ${kit.currentIdentity ?? "unknown"} → ${kit.latestIdentity ?? "unavailable"}`,
          ),
        )
      if (kit.latest?.origin?.remote?.upstreamCommitDate)
        console.log(
          plain(
            `  Upstream date: ${kit.latest.origin.remote.upstreamCommitDate} (informational)`,
          ),
        )
    }
    for (const file of files)
      console.log(plain(`File ${file.path} · ${file.status}\n  ${file.reason}`))
    for (const error of errors)
      console.error(plain(`Catalog warning: ${error}`))
    console.log(
      `${drift.kits.length} installed kits; ${drift.files.length} managed files checked.`,
    )
    if (kits.length || files.length || errors.length) process.exitCode = 1
    return
  }
  if (positionals.length) {
    if (positionals[0] !== "catalog")
      throw new Error("Unknown command. Use --help for usage.")
    if (
      positionals[1] === "add" &&
      positionals[2] &&
      positionals.length === 3
    ) {
      const catalog = await service.register(positionals[2])
      const inventory =
        catalog.hydration === "deferred" || catalog.hydration === "partial"
          ? "inventory loads on browse"
          : `${catalog.kits.length} available kits`
      console.log(plain(`Registered ${catalog.name} (${inventory})`))
      for (const issue of catalog.issues ?? [])
        console.error(plain(`Catalog warning: ${issue}`))
    } else if (
      positionals[1] === "remove" &&
      positionals[2] &&
      positionals.length === 3
    ) {
      await service.unregister(positionals[2])
      console.log("Catalog unregistered. Installed kit snapshots are retained.")
    } else if (positionals[1] === "list" && positionals.length === 2) {
      const { catalogs, errors } = await service.catalogs()
      for (const catalog of catalogs)
        console.log(
          plain(
            `${catalog.name} (${catalog.kind === "remote" ? "remote" : catalog.kind === "repo" ? "automatic" : catalog.permanent ? "built-in" : "registered"})\n  ${catalog.source}`,
          ),
        )
      for (const error of errors) console.error(plain(error))
    } else
      throw new Error(
        "Use: loadout catalog list | add <source> | remove <source>",
      )
    return
  }
  const model = new ScreenModel(service)
  await model.initialize()
  const preferences = await readPreferences(service.home)
  const bundled = typeof LOADOUT_BUNDLED !== "undefined" && LOADOUT_BUNDLED
  // Source/development runs never read update metadata or check for app updates.
  let version: string | undefined
  if (bundled) {
    try {
      const manifest = JSON.parse(
        await readFile(new URL("../package.json", import.meta.url), "utf8"),
      )
      if (isAppVersion(manifest.version)) version = manifest.version
    } catch {
      // An unreadable version must never prevent interactive startup.
    }
  }
  const [appUpdate, setAppUpdate] = createSignal<AppUpdateNotice>()
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
  })
  const updateController = new AbortController()
  const selfUpdate = createSelfUpdateClient({ bundled })
  let shuttingDown = false
  let exiting = false
  const preferenceSaves = new Set<Promise<void>>()
  const savePreference = (save: Promise<void>) => {
    preferenceSaves.add(save)
    void save.finally(() => preferenceSaves.delete(save)).catch(() => {})
    return save
  }
  const stopUpdateCheck = () => updateController.abort()
  const onDestroy = () => {
    shuttingDown = true
    stopUpdateCheck()
  }
  renderer.once(CliRenderEvents.DESTROY, onDestroy)
  const closeRenderer = () => closeSelfUpdateRenderer(renderer, selfUpdate)
  // Also covers renderer destruction outside App (terminal/native shutdown).
  void renderer.closed.then(() => selfUpdate?.dispose())
  const canUpdate = () =>
    !hasPendingSelfUpdateWork(model, {
      shuttingDown: shuttingDown || exiting,
      savingPreference: preferenceSaves.size > 0,
    })
  try {
    await render(
      () => (
        <App
          model={model}
          onExit={() => {
            if (exiting || shuttingDown) return
            exiting = true
            // A normal quit never becomes an update, including after a lost ACK.
            void Promise.allSettled([...preferenceSaves]).then(async () => {
              stopUpdateCheck()
              await closeRenderer()
            })
          }}
          walkthrough={values.walkthrough || !preferences.walkthroughSeen}
          onWalkthroughDismiss={() =>
            savePreference(dismissWalkthrough(service.home))
          }
          appUpdate={appUpdate()}
          onAppUpdateDismiss={(notice) => {
            setAppUpdate(undefined)
            void savePreference(
              dismissAppUpdate(service.home, notice.latestVersion),
            ).catch(() => {})
          }}
          onAppUpdateDiscover={
            selfUpdate
              ? async (signal) => {
                  if (!canUpdate() || signal?.aborted)
                    throw new Error(
                      "Finish pending work before updating Loadout.",
                    )
                  const available = await selfUpdate.discover(signal)
                  if (!canUpdate() || signal?.aborted)
                    throw new Error(
                      "Application update cancelled because work is pending.",
                    )
                  return available
                }
              : undefined
          }
          onAppUpdateConfirm={
            selfUpdate
              ? async (selection, appCanProceed, signal) => {
                  await completeSelfUpdateHandoff({
                    client: selfUpdate,
                    renderer,
                    selection,
                    signal,
                    canProceed: () => canUpdate() && appCanProceed(),
                    beforeClose: () => {
                      stopUpdateCheck()
                      model.cancelCatalogRefresh()
                    },
                    onHandoff: () => {
                      process.exitCode = SELF_UPDATE_EXIT_CODE
                    },
                  })
                }
              : undefined
          }
        />
      ),
      renderer,
    )
  } catch (error) {
    stopUpdateCheck()
    await closeRenderer()
    throw error
  }
  // Never hold the first render on registry/cache work.
  if (bundled && version && !updateController.signal.aborted)
    void checkForAppUpdate({
      home: service.home,
      version,
      signal: updateController.signal,
    })
      .then((notice) => {
        if (!updateController.signal.aborted) setAppUpdate(notice)
      })
      .catch(() => {})
  await renderer.closed
  selfUpdate?.dispose()
  renderer.removeListener(CliRenderEvents.DESTROY, onDestroy)
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(
    process.argv.includes("--json")
      ? JSON.stringify({ error: message })
      : plain(`Loadout: ${message}`),
  )
  process.exitCode = 1
})
