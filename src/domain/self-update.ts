import { isAppVersion } from "./app-update"

export type UpdateInstaller = "mise" | "npm"
export type SelfUpdateSelection = {
  installer: UpdateInstaller
  version: string
}
export type SelfUpdateAvailability = {
  installers: UpdateInstaller[]
  reason?: string
}

export const SELF_UPDATE_NONCE_ENV = "LOADOUT_SELF_UPDATE_NONCE"
export const SELF_UPDATE_EXIT_CODE = 42
export const SELF_UPDATE_PROTOCOL = 1

/** Display only. Execution always uses a fixed executable and argument array. */
export function formatSelfUpdateCommand(
  selection: SelfUpdateSelection,
): string {
  if (
    !selection ||
    !installer(selection.installer) ||
    !isAppVersion(selection.version)
  )
    throw new Error("Invalid application update selection.")
  return selection.installer === "mise"
    ? `mise use --global 'npm:@lidtop/loadout@${selection.version}'`
    : `npm install --global '@lidtop/loadout@${selection.version}' --ignore-scripts --registry https://registry.npmjs.org/`
}

export type SelfUpdateChildMessage =
  | { type: "loadout:self-update-discover"; protocol: 1; nonce: string }
  | ({
      type: "loadout:self-update-request"
      protocol: 1
      nonce: string
    } & SelfUpdateSelection)

export type SelfUpdateParentMessage =
  | ({
      type: "loadout:self-update-availability"
      protocol: 1
      nonce: string
    } & SelfUpdateAvailability)
  | { type: "loadout:self-update-accepted"; protocol: 1; nonce: string }
  | {
      type: "loadout:self-update-rejected"
      protocol: 1
      nonce: string
      reason: string
    }

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return (
    actual.length === expected.length &&
    actual.every(
      (key) =>
        typeof key === "string" &&
        expected.includes(key) &&
        Object.getOwnPropertyDescriptor(value, key)?.get === undefined &&
        Object.getOwnPropertyDescriptor(value, key)?.set === undefined,
    )
  )
}

function text(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= limit &&
    !/[\x00-\x1f\x7f-\x9f]/.test(value)
  )
}

function installer(value: unknown): value is UpdateInstaller {
  return value === "mise" || value === "npm"
}

function installerList(value: unknown): value is UpdateInstaller[] {
  return (
    Array.isArray(value) &&
    value.length <= 2 &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from(
      { length: value.length },
      (_, index) =>
        Object.getOwnPropertyDescriptor(value, String(index))?.value,
    ).every(installer) &&
    new Set(value).size === value.length
  )
}

function envelope(
  value: unknown,
  nonce: string,
): value is Record<string, unknown> {
  return (
    text(nonce, 256) &&
    record(value) &&
    Object.getOwnPropertyDescriptor(value, "protocol")?.value ===
      SELF_UPDATE_PROTOCOL &&
    Object.getOwnPropertyDescriptor(value, "nonce")?.value === nonce &&
    typeof Object.getOwnPropertyDescriptor(value, "type")?.value === "string"
  )
}

/** Only this child's nonce and the exact, path-free protocol are accepted. */
export function parseSelfUpdateChildMessage(
  value: unknown,
  nonce: string,
): SelfUpdateChildMessage | undefined {
  if (!envelope(value, nonce)) return
  if (
    value.type === "loadout:self-update-discover" &&
    keys(value, ["type", "protocol", "nonce"])
  )
    return { type: value.type, protocol: SELF_UPDATE_PROTOCOL, nonce }
  if (
    value.type === "loadout:self-update-request" &&
    keys(value, ["type", "protocol", "nonce", "installer", "version"]) &&
    installer(value.installer) &&
    isAppVersion(value.version)
  )
    return {
      type: value.type,
      protocol: SELF_UPDATE_PROTOCOL,
      nonce,
      installer: value.installer,
      version: value.version,
    }
}

export function parseSelfUpdateParentMessage(
  value: unknown,
  nonce: string,
): SelfUpdateParentMessage | undefined {
  if (!envelope(value, nonce)) return
  if (
    value.type === "loadout:self-update-accepted" &&
    keys(value, ["type", "protocol", "nonce"])
  )
    return { type: value.type, protocol: SELF_UPDATE_PROTOCOL, nonce }
  if (
    value.type === "loadout:self-update-rejected" &&
    keys(value, ["type", "protocol", "nonce", "reason"]) &&
    text(value.reason, 512)
  )
    return {
      type: value.type,
      protocol: SELF_UPDATE_PROTOCOL,
      nonce,
      reason: value.reason,
    }
  if (
    value.type === "loadout:self-update-availability" &&
    keys(value, [
      "type",
      "protocol",
      "nonce",
      "installers",
      ...(Object.hasOwn(value, "reason") ? ["reason"] : []),
    ]) &&
    installerList(value.installers) &&
    (!Object.hasOwn(value, "reason") || text(value.reason, 512))
  )
    return {
      type: value.type,
      protocol: SELF_UPDATE_PROTOCOL,
      nonce,
      installers: [...value.installers],
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    }
}
