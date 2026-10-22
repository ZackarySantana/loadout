import {
  parseSelfUpdateParentMessage,
  SELF_UPDATE_NONCE_ENV,
  SELF_UPDATE_PROTOCOL,
  type SelfUpdateAvailability,
  type SelfUpdateChildMessage,
  type SelfUpdateParentMessage,
  type SelfUpdateSelection,
} from "../domain/self-update"

export type SelfUpdateTransport = {
  connected?: boolean
  send?: (
    message: SelfUpdateChildMessage,
    callback: (error: Error | null) => void,
  ) => unknown
  on: (
    event: "message" | "disconnect",
    listener: (...args: any[]) => void,
  ) => unknown
  removeListener: (
    event: "message" | "disconnect",
    listener: (...args: any[]) => void,
  ) => unknown
  disconnect?: () => void
}

export type SelfUpdateClient = {
  discover: (signal?: AbortSignal) => Promise<SelfUpdateAvailability>
  request: (
    selection: SelfUpdateSelection,
    signal?: AbortSignal,
  ) => Promise<void>
  dispose: () => void
}

export type SelfUpdateRenderer = {
  destroy: () => void
  closed: Promise<void>
}

/** Restore/release the terminal before disconnecting the launcher's IPC. */
export async function closeSelfUpdateRenderer(
  renderer: SelfUpdateRenderer,
  client?: Pick<SelfUpdateClient, "dispose">,
): Promise<void> {
  renderer.destroy()
  await renderer.closed
  client?.dispose()
}

/** An ACK alone is not a handoff. Normal quit or new work wins while awaiting it. */
export async function completeSelfUpdateHandoff(options: {
  client: SelfUpdateClient
  renderer: SelfUpdateRenderer
  selection: SelfUpdateSelection
  canProceed: () => boolean
  beforeClose: () => void
  onHandoff: () => void
  signal?: AbortSignal
}): Promise<void> {
  const guard = () => {
    if (options.signal?.aborted || !options.canProceed())
      throw new Error(
        "Application update cancelled because work or shutdown is pending. No installer was run.",
      )
  }
  guard()
  await options.client.request(options.selection, options.signal)
  guard()
  options.beforeClose()
  await closeSelfUpdateRenderer(options.renderer, options.client)
  options.onHandoff()
}

/** No listeners, IPC traffic, or installer discovery outside the bundled TUI. */
export function createSelfUpdateClient(options: {
  bundled: boolean
  environment?: NodeJS.ProcessEnv
  transport?: SelfUpdateTransport
  timeoutMs?: number
}): SelfUpdateClient | undefined {
  const transport = options.transport ?? process
  const nonce = (options.environment ?? process.env)[SELF_UPDATE_NONCE_ENV]
  if (
    !options.bundled ||
    !nonce ||
    nonce.length > 256 ||
    /[\x00-\x1f\x7f-\x9f]/.test(nonce) ||
    !transport.send ||
    !transport.connected
  )
    return
  let disposed = false
  let pending:
    | {
        expected: SelfUpdateParentMessage["type"]
        finish: (error?: Error, message?: SelfUpdateParentMessage) => void
      }
    | undefined
  const unavailable = () =>
    new Error(
      "Automatic update connection closed. Update manually after exiting Loadout.",
    )
  const onMessage = (value: unknown) => {
    const message = parseSelfUpdateParentMessage(value, nonce)
    if (!message || !pending) return
    if (message.type === "loadout:self-update-rejected")
      pending.finish(new Error(message.reason))
    else if (message.type === pending.expected)
      pending.finish(undefined, message)
  }
  const onDisconnect = () => dispose(false)
  const dispose = (disconnect: boolean) => {
    if (!disposed) {
      disposed = true
      pending?.finish(unavailable())
      transport.removeListener("message", onMessage)
      transport.removeListener("disconnect", onDisconnect)
    }
    if (disconnect && transport.connected) {
      try {
        transport.disconnect?.()
      } catch {
        /* Already disconnected. */
      }
    }
  }
  transport.on("message", onMessage)
  transport.on("disconnect", onDisconnect)
  const rpc = (
    message: SelfUpdateChildMessage,
    expected: SelfUpdateParentMessage["type"],
    signal?: AbortSignal,
  ): Promise<SelfUpdateParentMessage> => {
    if (disposed || !transport.connected) return Promise.reject(unavailable())
    if (pending)
      return Promise.reject(
        new Error("An application update request is already pending."),
      )
    if (signal?.aborted)
      return Promise.reject(new Error("Application update cancelled."))
    return new Promise((resolve, reject) => {
      const cancel = () => finish(new Error("Application update cancelled."))
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              "Automatic update request timed out. Update manually or retry after restarting Loadout.",
            ),
          ),
        options.timeoutMs ?? 10_000,
      )
      const finish = (error?: Error, response?: SelfUpdateParentMessage) => {
        if (pending?.finish !== finish) return
        pending = undefined
        clearTimeout(timer)
        signal?.removeEventListener("abort", cancel)
        // Without request IDs, a late ACK must never approve a subsequent request.
        if (error) {
          dispose(false)
          reject(error)
        } else resolve(response!)
      }
      pending = { expected, finish }
      signal?.addEventListener("abort", cancel, { once: true })
      try {
        transport.send!(message, (error) => {
          if (error) finish(unavailable())
        })
      } catch {
        finish(unavailable())
      }
    })
  }
  return {
    async discover(signal) {
      const response = await rpc(
        {
          type: "loadout:self-update-discover",
          protocol: SELF_UPDATE_PROTOCOL,
          nonce,
        },
        "loadout:self-update-availability",
        signal,
      )
      if (response.type !== "loadout:self-update-availability")
        throw unavailable()
      return {
        installers: response.installers,
        ...(response.reason ? { reason: response.reason } : {}),
      }
    },
    async request(selection, signal) {
      await rpc(
        {
          type: "loadout:self-update-request",
          protocol: SELF_UPDATE_PROTOCOL,
          nonce,
          ...selection,
        },
        "loadout:self-update-accepted",
        signal,
      )
    },
    dispose: () => dispose(true),
  }
}

/** Shared by App and CLI; never clear drafts or write kit/settings state here. */
export function hasPendingSelfUpdateWork(
  model: {
    stagedCount: () => number
    settingsChanged: () => boolean
    form?: unknown
    settingsForm?: unknown
    catalogRefreshForm?: unknown
    editing?: unknown
    registering: boolean
    busy: boolean
    catalogProgress?: unknown
  },
  state: {
    walkthrough?: boolean
    savingPreference?: boolean
    exitPrompt?: boolean
    shuttingDown?: boolean
  } = {},
): boolean {
  return Boolean(
    model.stagedCount() ||
    model.settingsChanged() ||
    model.form ||
    model.settingsForm ||
    model.catalogRefreshForm ||
    model.editing ||
    model.registering ||
    model.busy ||
    model.catalogProgress ||
    state.walkthrough ||
    state.savingPreference ||
    state.exitPrompt ||
    state.shuttingDown,
  )
}
