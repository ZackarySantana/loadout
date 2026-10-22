import { constants } from "node:fs"
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { z } from "zod"
import {
  compareAppVersions,
  isAppVersion,
  type AppUpdateNotice,
} from "../domain/app-update"
import { assertSafeDirectory, assertSafePath } from "./files"

const day = 24 * 60 * 60 * 1000
const maxPrivateFileBytes = 16 * 1024
const maxResponseBytes = 128 * 1024
const cacheSchema = z
  .object({
    channel: z.enum(["stable", "prerelease"]),
    checkedAt: z.number().int().nonnegative().safe(),
    latestVersion: z.string().refine(isAppVersion).optional(),
  })
  .strict()
type Cache = z.infer<typeof cacheSchema>
const dismissalSchema = z
  .object({ dismissedVersion: z.string().refine(isAppVersion) })
  .strict()
type PrivateFile = { content: string; mode: number }

function prerelease(version: string): boolean {
  return version.split("+")[0]!.includes("-")
}

/** Bounded before allocation, and never follows a non-regular leaf or parent link. */
async function readPrivateFile(path: string): Promise<PrivateFile | undefined> {
  await assertSafeDirectory(dirname(path))
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (!info.isFile() || info.size > maxPrivateFileBytes)
    throw new Error("Application update metadata must be a small regular file")
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.ino !== info.ino ||
      opened.dev !== info.dev ||
      opened.size > maxPrivateFileBytes
    )
      throw new Error("Application update metadata changed while reading")
    const bytes = Buffer.alloc(opened.size + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== opened.size)
      throw new Error("Application update metadata changed while reading")
    await assertSafePath(path)
    const after = await lstat(path)
    if (
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new Error("Application update metadata changed while reading")
    return {
      content: new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, bytesRead),
      ),
      mode: opened.mode & 0o7777,
    }
  } finally {
    await handle.close()
  }
}

async function readCache(path: string): Promise<Cache | undefined> {
  try {
    const file = await readPrivateFile(path)
    if (!file) return
    const record = cacheSchema.parse(JSON.parse(file.content))
    if (
      record.checkedAt > Date.now() ||
      (record.channel === "stable" &&
        record.latestVersion &&
        prerelease(record.latestVersion))
    )
      return
    return record
  } catch {
    return
  }
}

async function writePrivateFile(
  path: string,
  content: string,
  signal?: AbortSignal,
  expected?: { file: PrivateFile | undefined },
): Promise<boolean> {
  let temporary: string | undefined
  try {
    if (signal?.aborted) return false
    if (Buffer.byteLength(content) > maxPrivateFileBytes)
      throw new Error("Application update metadata is too large")
    await assertSafeDirectory(dirname(path))
    await assertSafePath(path)
    if (signal?.aborted) return false
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await assertSafeDirectory(dirname(path))
    if (signal?.aborted) return false
    const candidate = `${path}.${randomUUID()}.tmp`
    const handle = await open(
      candidate,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    )
    temporary = candidate
    try {
      if (signal?.aborted) return false
      await handle.writeFile(content)
    } finally {
      await handle.close()
    }
    await assertSafeDirectory(dirname(path))
    await assertSafePath(path)
    if (expected) {
      const current = await readPrivateFile(path)
      if (
        current?.content !== expected.file?.content ||
        current?.mode !== expected.file?.mode
      )
        return false
    }
    if (signal?.aborted) return false
    await rename(temporary, path)
    temporary = undefined
    return true
  } finally {
    if (temporary) {
      try {
        await assertSafeDirectory(dirname(path))
        await unlink(temporary)
      } catch {
        // Only this invocation's randomly named temporary file is considered.
      }
    }
  }
}

function dismissedVersion(file: PrivateFile | undefined): string | undefined {
  return file
    ? dismissalSchema.parse(JSON.parse(file.content)).dismissedVersion
    : undefined
}

function canonicalVersion(version: string): string {
  return version.split("+")[0]!
}

function dismissalPath(home: string, version: string): string {
  const hash = createHash("sha256")
    .update(canonicalVersion(version))
    .digest("hex")
  return join(resolve(home), ".loadout/app-update-notices", `${hash}.json`)
}

/** Independent UI acknowledgements leave older-client preferences unchanged. */
export async function dismissAppUpdate(
  home: string,
  version: string,
): Promise<void> {
  if (!isAppVersion(version))
    throw new Error("Invalid application update version")
  const canonical = canonicalVersion(version)
  const path = dismissalPath(home, canonical)
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readPrivateFile(path)
    if (before) {
      if (dismissedVersion(before) === canonical) return
      throw new Error(
        "Refusing to overwrite unrecognized application notice metadata",
      )
    }
    // Concurrent acknowledgements of this version are identical. If another writer
    // finishes first, retry the exact file and recognize its completed record.
    if (
      await writePrivateFile(
        path,
        JSON.stringify({ dismissedVersion: canonical }) + "\n",
        undefined,
        { file: before },
      )
    )
      return
  }
  throw new Error("Application notice preferences changed; retry dismissing")
}

async function registryVersion(
  tag: "latest" | "next",
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    if (signal.aborted) return
    const response = await fetch(
      `https://registry.npmjs.org/@lidtop%2floadout/${tag}`,
      {
        headers: { accept: "application/json" },
        credentials: "omit",
        redirect: "error",
        signal,
      },
    )
    if (!response.body) return
    const reader = response.body.getReader()
    try {
      if (
        !response.ok ||
        Number(response.headers.get("content-length")) > maxResponseBytes
      )
        return
      const chunks: Uint8Array[] = []
      let length = 0
      while (true) {
        if (signal.aborted) return
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.byteLength
        if (length > maxResponseBytes) return
        chunks.push(chunk.value)
      }
      if (signal.aborted) return
      const metadata: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      )
      if (
        typeof metadata === "object" &&
        metadata !== null &&
        !Array.isArray(metadata) &&
        "name" in metadata &&
        metadata.name === "@lidtop/loadout" &&
        "version" in metadata &&
        isAppVersion(metadata.version)
      )
        return metadata.version
    } finally {
      await reader.cancel().catch(() => {})
    }
  } catch {
    // Offline, timeout, abort, and invalid registry data are all silent misses.
  }
}

/** Called once after an interactive TUI mounts, never by machine/JSON commands. */
export async function checkForAppUpdate({
  home,
  version,
  environment = process.env,
  signal,
}: {
  home: string
  version: string
  environment?: Record<string, string | undefined>
  signal?: AbortSignal
}): Promise<AppUpdateNotice | undefined> {
  try {
    const enabled = (value: string | undefined) =>
      /^(1|true)$/i.test(value ?? "")
    if (
      enabled(environment.LOADOUT_NO_UPDATE_CHECK) ||
      enabled(environment.NO_UPDATE_NOTIFIER) ||
      enabled(environment.CI) ||
      signal?.aborted ||
      !isAppVersion(version)
    )
      return
    const channel = prerelease(version) ? "prerelease" : "stable"
    const root = environment.XDG_CACHE_HOME
    const path = join(
      root && isAbsolute(root) ? root : join(resolve(home), ".cache"),
      "loadout/app-update.json",
    )
    const cached = await readCache(path)
    if (signal?.aborted) return
    const matching = cached?.channel === channel ? cached : undefined
    let latestVersion = matching?.latestVersion
    if (!matching || Date.now() - matching.checkedAt >= day) {
      const timeout = AbortSignal.timeout(2500)
      const requestSignal = signal
        ? AbortSignal.any([signal, timeout])
        : timeout
      const candidates = await Promise.all(
        (channel === "stable"
          ? (["latest"] as const)
          : (["latest", "next"] as const)
        ).map((tag) => registryVersion(tag, requestSignal)),
      )
      if (signal?.aborted) return
      const versions = candidates.filter(
        (candidate): candidate is string =>
          candidate !== undefined &&
          (channel === "prerelease" || !prerelease(candidate)),
      )
      if (versions.length)
        latestVersion = versions.reduce((highest, candidate) =>
          compareAppVersions(candidate, highest)! > 0 ? candidate : highest,
        )
      // Failed attempts are cached too, retaining any known release for this channel.
      await writePrivateFile(
        path,
        JSON.stringify({
          channel,
          checkedAt: Date.now(),
          ...(latestVersion ? { latestVersion } : {}),
        }) + "\n",
        signal,
      ).catch(() => {})
    }
    if (
      signal?.aborted ||
      !latestVersion ||
      compareAppVersions(latestVersion, version)! <= 0
    )
      return
    // Read at emission time: an in-flight request must not undo another dismissal.
    const dismissed = dismissedVersion(
      await readPrivateFile(dismissalPath(home, latestVersion)),
    )
    if (signal?.aborted || dismissed === canonicalVersion(latestVersion)) return
    return { currentVersion: version, latestVersion }
  } catch {
    // No application-update failure is surfaced as a catalog warning or TUI error.
    return
  }
}
