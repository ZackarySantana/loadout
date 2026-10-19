#!/usr/bin/env bun
import { homedir } from "node:os"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { LoadoutService } from "./backend/service"
import { ScreenModel } from "./frontend/model"
import { App } from "./frontend/App"

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

Tab switches pages. Arrows navigate. Space selects. Esc goes back.
Kit changes are written only after review and explicit confirmation.
Catalog registration updates Loadout's registry immediately.`)
    return
  }
  const service = await LoadoutService.open({
    home: homedir(),
    repository: resolve(values.repo ?? process.cwd()),
  })
  if (positionals.length) {
    if (positionals[0] !== "catalog")
      throw new Error("Unknown command. Use --help for usage.")
    if (
      positionals[1] === "add" &&
      positionals[2] &&
      positionals.length === 3
    ) {
      const catalog = await service.register(positionals[2])
      console.log(`Registered ${catalog.name} (${catalog.kits.length} kits)`)
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
          `${catalog.name}${catalog.permanent ? " (built-in)" : ""}\n  ${catalog.source}`,
        )
      for (const error of errors) console.error(error)
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
