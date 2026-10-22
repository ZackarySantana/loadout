#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { lstat } from "node:fs/promises"
import { constants, homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import {
  discoverOwnedInstallers,
  performSelfUpdate,
  validateSelfUpdateInstallation,
  type SelfUpdateContext,
} from "./backend/self-update"
import { compareAppVersions } from "./domain/app-update"
import {
  parseSelfUpdateChildMessage,
  SELF_UPDATE_EXIT_CODE,
  SELF_UPDATE_NONCE_ENV,
  SELF_UPDATE_PROTOCOL,
  type SelfUpdateAvailability,
  type SelfUpdateParentMessage,
  type SelfUpdateSelection,
} from "./domain/self-update"

declare const LOADOUT_BUNDLED: boolean

async function isCheckout(root: string): Promise<boolean> {
  try {
    // A worktree's .git file, a directory, and even a dangling link all disable IPC.
    await lstat(join(root, ".git"))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

type ChildResult = {
  code: number | null
  signal: NodeJS.Signals | null
  selection?: SelfUpdateSelection
  failed: boolean
}

async function main(): Promise<number> {
  // These values belong to the original shell invocation, not a later install.
  const cwd = process.cwd()
  const args = process.argv.slice(2)
  const environment = { ...process.env }
  for (const key of Object.keys(environment))
    if (
      [
        SELF_UPDATE_NONCE_ENV,
        "NODE_CHANNEL_FD",
        "NODE_CHANNEL_SERIALIZATION_MODE",
      ].includes(key.toUpperCase())
    )
      delete environment[key]
  const controller = new AbortController()
  let active: ChildProcess | undefined
  let interrupted: number | undefined
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    interrupted ??= signal === "SIGINT" ? 130 : 143
    controller.abort()
    active?.kill(signal)
  }
  const onInterrupt = () => interrupt("SIGINT")
  const onTerminate = () => interrupt("SIGTERM")
  process.on("SIGINT", onInterrupt)
  process.on("SIGTERM", onTerminate)
  try {
    let installation = await validateSelfUpdateInstallation(
      fileURLToPath(new URL("..", import.meta.url)),
    )
    const bundled = typeof LOADOUT_BUNDLED !== "undefined" && LOADOUT_BUNDLED
    const context = (): SelfUpdateContext => {
      // Match the UI's grammar, but only parse after an explicit update request.
      // Neither IPC nor a replacement installation can choose the project path.
      const { values } = parseArgs({
        args,
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
      return {
        packageRoot: installation.packageRoot,
        version: installation.version,
        nodePath: process.execPath,
        cwd,
        repository:
          values.repo === undefined ? undefined : resolve(cwd, values.repo),
        home: homedir(),
        environment: { ...environment },
        signal: controller.signal,
      }
    }
    while (!interrupted) {
      // No ownership query, network request, or package-manager process runs here.
      const nonce =
        bundled && !(await isCheckout(installation.packageRoot))
          ? randomBytes(32).toString("hex")
          : undefined
      if (interrupted) return interrupted
      const childEnvironment = { ...environment }
      if (nonce) childEnvironment[SELF_UPDATE_NONCE_ENV] = nonce
      const childController = new AbortController()
      const childSignal = AbortSignal.any([
        controller.signal,
        childController.signal,
      ])
      const child = spawn(
        process.execPath,
        ["--experimental-ffi", installation.entry, ...args],
        {
          cwd,
          env: childEnvironment,
          stdio: nonce ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
          shell: false,
        },
      )
      active = child
      let closed = false
      let selected: SelfUpdateSelection | undefined
      let availability: Promise<SelfUpdateAvailability> | undefined
      const send = (message: SelfUpdateParentMessage) => {
        if (closed || !child.connected) return
        try {
          child.send(message, () => {})
        } catch {
          // A lost ACK is not a handoff: only the child's close status can be one.
        }
      }
      const reject = (reason: string) => {
        if (nonce)
          send({
            type: "loadout:self-update-rejected",
            protocol: SELF_UPDATE_PROTOCOL,
            nonce,
            reason,
          })
      }
      const receive = async (value: unknown) => {
        if (!nonce || closed || interrupted) return
        const message = parseSelfUpdateChildMessage(value, nonce)
        if (!message) return
        if (
          message.type === "loadout:self-update-request" &&
          (compareAppVersions(message.version, installation.version) ?? -1) <= 0
        ) {
          reject("Select a newer application version.")
          return
        }
        availability ??= discoverOwnedInstallers({
          ...context(),
          signal: childSignal,
        }).catch(() => ({
          installers: [],
          reason: "Automatic updates are unavailable for this installation.",
        }))
        const owned = await availability
        if (closed || interrupted) return
        if (message.type === "loadout:self-update-discover") {
          send({
            type: "loadout:self-update-availability",
            protocol: SELF_UPDATE_PROTOCOL,
            nonce,
            ...owned,
          })
          return
        }
        if (!owned.installers.includes(message.installer)) {
          reject("The selected installer does not own this installation.")
          return
        }
        if (
          selected &&
          (selected.installer !== message.installer ||
            selected.version !== message.version)
        ) {
          reject("A different application update was already accepted.")
          return
        }
        selected ??= { installer: message.installer, version: message.version }
        send({
          type: "loadout:self-update-accepted",
          protocol: SELF_UPDATE_PROTOCOL,
          nonce,
        })
      }
      const onMessage = (value: unknown) => {
        void receive(value).catch(() =>
          reject("The application update request could not be verified."),
        )
      }
      if (nonce) child.on("message", onMessage)
      const result = await new Promise<ChildResult>((resolve) => {
        let failed = false
        child.on("error", () => {
          failed = true
        })
        // close, not exit: native handles and inherited stdio must be released.
        child.once("close", (code, signal) => {
          closed = true
          child.removeListener("message", onMessage)
          childController.abort()
          active = undefined
          resolve({ code, signal, selection: selected, failed })
        })
      })
      if (interrupted) return interrupted
      if (result.failed)
        throw new Error("The application process could not run.")
      if (result.signal) return 128 + (constants.signals[result.signal] ?? 1)
      if (result.code !== SELF_UPDATE_EXIT_CODE) return result.code ?? 1
      if (!result.selection)
        throw new Error(
          "The application exited for an update without an accepted request.",
        )

      // An ACK alone never permits installation. A normal quit drops it entirely.
      const updated = await performSelfUpdate(context(), result.selection)
      if (interrupted) return interrupted
      installation = await validateSelfUpdateInstallation(
        updated.packageRoot,
        result.selection.version,
      )
    }
    return interrupted ?? 1
  } catch (error) {
    if (interrupted) return interrupted
    const message =
      error instanceof Error ? error.message : "Application update failed."
    console.error(`Loadout: ${message.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")}`)
    return 1
  } finally {
    process.removeListener("SIGINT", onInterrupt)
    process.removeListener("SIGTERM", onTerminate)
  }
}

process.exitCode = await main()
