import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import {
  closeSelfUpdateRenderer,
  completeSelfUpdateHandoff,
  createSelfUpdateClient,
  hasPendingSelfUpdateWork,
  type SelfUpdateTransport,
} from "../src/frontend/self-update-client"
import {
  SELF_UPDATE_NONCE_ENV,
  type SelfUpdateChildMessage,
} from "../src/domain/self-update"

const nonce = "mock-supervisor-nonce"
const envelope = { protocol: 1, nonce } as const

class Transport extends EventEmitter implements SelfUpdateTransport {
  connected = true
  messages: SelfUpdateChildMessage[] = []
  disconnections = 0
  sendError?: Error
  send(
    message: SelfUpdateChildMessage,
    callback: (error: Error | null) => void,
  ) {
    this.messages.push(message)
    callback(this.sendError ?? null)
  }
  disconnect() {
    this.disconnections++
    this.connected = false
    this.emit("disconnect")
  }
}

function client(transport = new Transport(), timeoutMs = 1000) {
  return {
    transport,
    client: createSelfUpdateClient({
      bundled: true,
      environment: { [SELF_UPDATE_NONCE_ENV]: nonce },
      transport,
      timeoutMs,
    })!,
  }
}

test("self-update client stays inert outside a supervised bundled TUI", () => {
  const transport = new Transport()
  for (const options of [
    { bundled: false, environment: { [SELF_UPDATE_NONCE_ENV]: nonce } },
    { bundled: true, environment: {} },
    { bundled: true, environment: { [SELF_UPDATE_NONCE_ENV]: "bad\nnonce" } },
  ])
    expect(createSelfUpdateClient({ ...options, transport })).toBeUndefined()
  expect(transport.eventNames()).toEqual([])
  expect(transport.messages).toEqual([])
})

test("discovery and confirmation are separate explicit RPCs with strict replies", async () => {
  const { transport, client: updater } = client()
  try {
    expect(transport.messages).toEqual([])
    const discovery = updater.discover()
    expect(transport.messages).toEqual([
      { ...envelope, type: "loadout:self-update-discover" },
    ])
    transport.emit("message", {
      ...envelope,
      type: "loadout:self-update-availability",
      installers: ["mise", "npm"],
    })
    expect(await discovery).toEqual({ installers: ["mise", "npm"] })
    expect(transport.messages).toHaveLength(1)
    const request = updater.request({ installer: "mise", version: "0.6.0" })
    let accepted = false
    void request.then(() => (accepted = true))
    transport.emit("message", {
      ...envelope,
      nonce: "wrong",
      type: "loadout:self-update-accepted",
    })
    transport.emit("message", {
      ...envelope,
      type: "loadout:self-update-accepted",
      command: "not permitted",
    })
    await Promise.resolve()
    expect(accepted).toBe(false)
    transport.emit("message", {
      ...envelope,
      type: "loadout:self-update-accepted",
    })
    await request
    expect(accepted).toBe(true)
    expect(transport.messages[1]).toEqual({
      ...envelope,
      type: "loadout:self-update-request",
      installer: "mise",
      version: "0.6.0",
    })
  } finally {
    updater.dispose()
  }
  expect(transport.eventNames()).toEqual([])
  expect(transport.disconnections).toBe(1)
})

test("lost ACK retires the client; final shutdown still disconnects IPC", async () => {
  const { transport, client: updater } = client(new Transport(), 5)
  try {
    await expect(
      updater.request({ installer: "npm", version: "0.6.0" }),
    ).rejects.toThrow("timed out")
    expect(transport.connected).toBe(true)
    expect(transport.eventNames()).toEqual([])
    transport.emit("message", {
      ...envelope,
      type: "loadout:self-update-accepted",
    })
    await expect(
      updater.request({ installer: "npm", version: "0.6.0" }),
    ).rejects.toThrow("connection closed")
    expect(transport.messages).toHaveLength(1)
  } finally {
    updater.dispose()
    updater.dispose()
  }
  expect(transport.connected).toBe(false)
  expect(transport.disconnections).toBe(1)
})

test("overlapping and already-cancelled requests never send a second command", async () => {
  const { transport, client: updater } = client()
  const controller = new AbortController()
  controller.abort()
  try {
    await expect(updater.discover(controller.signal)).rejects.toThrow(
      "cancelled",
    )
    expect(transport.messages).toEqual([])
    const discovery = updater.discover()
    await expect(
      updater.request({ installer: "npm", version: "0.6.0" }),
    ).rejects.toThrow("already pending")
    expect(transport.messages).toHaveLength(1)
    transport.emit("message", {
      ...envelope,
      type: "loadout:self-update-availability",
      installers: [],
      reason: "Manual update required",
    })
    expect(await discovery).toEqual({
      installers: [],
      reason: "Manual update required",
    })
  } finally {
    updater.dispose()
  }
})

test("cancellation, rejection, send failure and disconnect reject without accepting", async () => {
  for (const failure of ["abort", "reject", "send", "disconnect"] as const) {
    const { transport, client: updater } = client()
    const controller = new AbortController()
    if (failure === "send") transport.sendError = new Error("mock send failed")
    const request = updater.request(
      { installer: "npm", version: "0.6.0" },
      controller.signal,
    )
    if (failure === "abort") controller.abort()
    if (failure === "reject")
      transport.emit("message", {
        ...envelope,
        type: "loadout:self-update-rejected",
        reason: "Not owned",
      })
    if (failure === "disconnect") transport.disconnect()
    try {
      await expect(request).rejects.toThrow()
      expect(transport.eventNames()).toEqual([])
    } finally {
      updater.dispose()
    }
    expect(transport.connected).toBe(false)
    expect(transport.disconnections).toBe(1)
  }
})

test("pending-work guard blocks all drafts, forms, work and shutdown states", () => {
  const idle = {
    stagedCount: () => 0,
    settingsChanged: () => false,
    registering: false,
    busy: false,
  }
  expect(hasPendingSelfUpdateWork(idle)).toBe(false)
  expect(hasPendingSelfUpdateWork({ ...idle, stagedCount: () => 1 })).toBe(true)
  expect(
    hasPendingSelfUpdateWork({ ...idle, settingsChanged: () => true }),
  ).toBe(true)
  for (const key of [
    "form",
    "settingsForm",
    "catalogRefreshForm",
    "editing",
    "registering",
    "busy",
    "catalogProgress",
  ])
    expect(hasPendingSelfUpdateWork({ ...idle, [key]: true })).toBe(true)
  for (const key of [
    "walkthrough",
    "savingPreference",
    "exitPrompt",
    "shuttingDown",
  ])
    expect(hasPendingSelfUpdateWork(idle, { [key]: true })).toBe(true)
  expect(idle.stagedCount()).toBe(0)
  expect(idle.settingsChanged()).toBe(false)
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

test("handoff waits for acceptance and renderer closure before disconnect and update exit", async () => {
  const events: string[] = []
  const ack = deferred()
  const closed = deferred()
  const handoff = completeSelfUpdateHandoff({
    client: {
      discover: async () => ({ installers: [] }),
      request: () => {
        events.push("request")
        return ack.promise
      },
      dispose: () => events.push("disconnect"),
    },
    renderer: {
      destroy: () => events.push("destroy"),
      closed: closed.promise,
    },
    selection: { installer: "mise", version: "0.6.0" },
    canProceed: () => true,
    beforeClose: () => events.push("abort-background-work"),
    onHandoff: () => events.push("update-exit"),
  })
  expect(events).toEqual(["request"])
  ack.resolve()
  await Promise.resolve()
  expect(events).toEqual(["request", "abort-background-work", "destroy"])
  closed.resolve()
  await handoff
  expect(events).toEqual([
    "request",
    "abort-background-work",
    "destroy",
    "disconnect",
    "update-exit",
  ])
})

test("normal quit or newly pending work after acceptance prevents update handoff", async () => {
  for (const pendingAfterAck of ["normal-quit", "new-draft"] as const) {
    const ack = deferred()
    const events: string[] = []
    let canProceed = true
    const handoff = completeSelfUpdateHandoff({
      client: {
        discover: async () => ({ installers: [] }),
        request: () => ack.promise,
        dispose: () => events.push("disconnect"),
      },
      renderer: {
        destroy: () => events.push("destroy"),
        closed: Promise.resolve(),
      },
      selection: { installer: "npm", version: "0.6.0" },
      canProceed: () => canProceed,
      beforeClose: () => events.push("abort-background-work"),
      onHandoff: () => events.push("update-exit"),
    })
    canProceed = false
    events.push(pendingAfterAck)
    ack.resolve()
    await expect(handoff).rejects.toThrow("work or shutdown")
    expect(events).toEqual([pendingAfterAck])
  }
})

test("blocked or unaccepted requests never destroy the renderer for an update", async () => {
  for (const blocked of [true, false]) {
    const events: string[] = []
    await expect(
      completeSelfUpdateHandoff({
        client: {
          discover: async () => ({ installers: [] }),
          request: async () => {
            events.push("request")
            throw new Error("Lost ACK")
          },
          dispose: () => events.push("disconnect"),
        },
        renderer: {
          destroy: () => events.push("destroy"),
          closed: Promise.resolve(),
        },
        selection: { installer: "npm", version: "0.6.0" },
        canProceed: () => !blocked,
        beforeClose: () => events.push("abort-background-work"),
        onHandoff: () => events.push("update-exit"),
      }),
    ).rejects.toThrow(blocked ? "work or shutdown" : "Lost ACK")
    expect(events).toEqual(blocked ? [] : ["request"])
  }
})

test("normal shutdown also releases IPC only after terminal closure", async () => {
  const events: string[] = []
  const closed = deferred()
  const shutdown = closeSelfUpdateRenderer(
    { destroy: () => events.push("destroy"), closed: closed.promise },
    { dispose: () => events.push("disconnect") },
  )
  await Promise.resolve()
  expect(events).toEqual(["destroy"])
  closed.resolve()
  await shutdown
  expect(events).toEqual(["destroy", "disconnect"])
})
