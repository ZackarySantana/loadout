#!/usr/bin/env bun
import { homedir } from "node:os"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { LoadoutService } from "./backend/service"
import { ScreenModel } from "./frontend/model"
import { App } from "./frontend/App"
import { displayKitKey } from "./domain/catalog"

const plain = (value: string) =>
  value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  })
  if (values.help) {
    console.log(`Loadout · compose agent instructions and skills

Usage: loadout [--repo <project>]
       loadout catalog list
       loadout catalog add <catalog.json path or HTTPS URL>
       loadout catalog remove <registered source>
       loadout status

Tab switches pages. Up/Down or j/k navigate; Left/Right or h/l navigate options.
Text questions start editing on focus; Vim keys then type normally.
Space selects. Esc accepts an open kit; otherwise it goes back. Press q twice to exit.
Kit and settings changes are written only after review and explicit confirmation.
Repo kits are discovered automatically from .loadout/kits/*.yaml; no repo catalog index or registration is needed.
Registration is only for external catalogs and installs no kits.
Status is read-only; a nonzero exit code means drift or catalog issues were found.`)
    return
  }
  const service = await LoadoutService.open({
    home: homedir(),
    repository: resolve(values.repo ?? process.cwd()),
  })
  if (positionals[0] === "status" && positionals.length === 1) {
    const { drift, errors } = await service.status()
    const kits = drift.kits.filter((kit) => kit.status !== "current")
    const files = drift.files.filter((file) => file.status !== "current")
    if (!kits.length && !files.length && !errors.length)
      console.log("No drift detected.")
    for (const kit of kits)
      console.log(
        plain(
          `Kit ${displayKitKey(kit.key)} [${kit.scope}] · ${kit.status}\n  ${kit.reason}`,
        ),
      )
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
      console.log(
        plain(
          `Registered ${catalog.name} (${catalog.kits.length} available kits)`,
        ),
      )
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
            `${catalog.name} (${catalog.kind === "repo" ? "automatic" : catalog.permanent ? "built-in" : "registered"})\n  ${catalog.source}`,
          ),
        )
      for (const error of errors) console.error(plain(error))
    } else
      throw new Error(
        "Use: loadout catalog list | add <source> | remove <source>",
      )
    return
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "The TUI requires an interactive terminal. Use --help for CLI commands.",
    )
  const model = new ScreenModel(service)
  await model.initialize()
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
  })
  await render(
    () => <App model={model} onExit={() => renderer.destroy()} />,
    renderer,
  )
}

main().catch((error) => {
  console.error(
    `Loadout: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
})
