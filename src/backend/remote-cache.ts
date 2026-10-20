import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { z } from "zod"
import { canonical } from "../domain/content"
import { catalogOriginSchema, kitSchema, type Catalog } from "../domain/kit"
import {
  remoteSkillsSourceSchema,
  type RemoteSkillsSource,
} from "../domain/catalog-source"
import { assertSafeDirectory, assertSafePath } from "./files"

const maxEntry = 96 * 1024 * 1024
const maxTotal = 256 * 1024 * 1024
const filename = /^remote-[a-f0-9]{64}-[a-f0-9]{64}\.json$/
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const sha = z.string().regex(/^[a-f0-9]{40}$/)
const cachedCatalogSchema = z
  .object({
    id: z.string().max(200),
    name: z.string().max(200),
    source: z.string().max(8192),
    permanent: z.boolean(),
    automatic: z.boolean().optional(),
    kind: z.literal("remote"),
    hydration: z.literal("loaded"),
    kits: z
      .array(
        z
          .object({
            key: z.string().max(512),
            kit: kitSchema,
            origin: catalogOriginSchema,
          })
          .strict(),
      )
      .max(500),
    unavailableKits: z
      .array(
        z
          .object({
            key: z.string().max(512).optional(),
            id: z.string().max(200).optional(),
            name: z.string().max(1024),
            source: z.string().max(32768),
            reason: z.string().max(16384),
          })
          .strict(),
      )
      .max(500),
    issues: z.array(z.string().max(32768)).max(500),
  })
  .strict()
const recordSchema = z
  .object({
    kind: z.literal("remote-skills-cache"),
    source: z.string().max(8192),
    descriptor: remoteSkillsSourceSchema,
    commit: sha,
    checkedAt: z.string().datetime({ offset: true }),
    catalog: cachedCatalogSchema,
    blobs: z.record(sha, z.string().max(3 * 1024 * 1024)),
    integrity: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type RemoteCacheRecord = z.infer<typeof recordSchema>
export function gitBlobHash(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex")
}
function cachePath(
  directory: string,
  source: string,
  descriptor: RemoteSkillsSource,
): string {
  return join(
    resolve(directory),
    `remote-${sourceHash(source)}-${hash(canonical(descriptor))}.json`,
  )
}
function sourceHash(source: string): string {
  return hash(
    source.startsWith("https://") ? new URL(source).href : resolve(source),
  )
}

/** Disposable browse data only. Nothing is read or written without an injected directory. */
export async function readRemoteCache(
  directory: string | undefined,
  source: string,
  descriptor: RemoteSkillsSource,
  signal?: AbortSignal,
): Promise<RemoteCacheRecord | undefined> {
  signal?.throwIfAborted()
  if (!directory) return
  return readCachePath(
    directory,
    source,
    cachePath(directory, source, descriptor),
    descriptor,
    signal,
  )
}

/** Source-prefix lookup is browse-only discovery, never current-descriptor proof. */
export async function readRemoteCacheForSource(
  directory: string | undefined,
  source: string,
  signal?: AbortSignal,
): Promise<RemoteCacheRecord | undefined> {
  signal?.throwIfAborted()
  if (!directory) return
  try {
    await assertSafeDirectory(directory)
    signal?.throwIfAborted()
    const prefix = `remote-${sourceHash(source)}-`
    const names = (await readdir(directory)).filter(
      (name) => filename.test(name) && name.startsWith(prefix),
    )
    if (names.length > 16) return
    const candidates = []
    for (const name of names) {
      signal?.throwIfAborted()
      const path = join(resolve(directory), name)
      const info = await lstat(path)
      if (!info.isFile() || info.size > maxEntry) continue
      // checkedAt is written before the potentially large descriptor/catalog.
      // Rank matching records using at most 64 KiB each, then validate only the
      // newest complete candidate rather than parsing every cached catalog.
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const opened = await handle.stat()
        if (
          !opened.isFile() ||
          opened.ino !== info.ino ||
          opened.dev !== info.dev
        )
          continue
        const prefix = Buffer.alloc(Math.min(info.size, 64 * 1024))
        const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
        signal?.throwIfAborted()
        const match = /(?<!\\)"checkedAt":"([^"\\]{1,64})"/.exec(
          prefix.subarray(0, bytesRead).toString("utf8"),
        )
        if (
          !match ||
          !z.string().datetime({ offset: true }).safeParse(match[1]).success
        )
          continue
        const at = Date.parse(match[1]!)
        if (at <= Date.now() + 60_000) candidates.push({ path, at })
      } finally {
        await handle.close()
      }
    }
    // Only matching-source files are opened, newest checkedAt first. Header hints
    // are not authority: the complete record and timestamp must validate below.
    candidates.sort((a, b) => b.at - a.at)
    for (const candidate of candidates) {
      signal?.throwIfAborted()
      const record = await readCachePath(
        directory,
        source,
        candidate.path,
        undefined,
        signal,
      )
      if (record && Date.parse(record.checkedAt) === candidate.at) return record
    }
  } catch {
    signal?.throwIfAborted()
  }
}

async function readCachePath(
  directory: string,
  source: string,
  path: string,
  expectedDescriptor?: RemoteSkillsSource,
  signal?: AbortSignal,
): Promise<RemoteCacheRecord | undefined> {
  try {
    signal?.throwIfAborted()
    await assertSafeDirectory(directory)
    const info = await lstat(path)
    if (!info.isFile() || info.size > maxEntry) return
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes: Buffer
    try {
      const opened = await handle.stat()
      if (
        !opened.isFile() ||
        opened.ino !== info.ino ||
        opened.dev !== info.dev ||
        opened.size > maxEntry
      )
        return
      // A bounded read also protects against a file growing after stat.
      bytes = Buffer.alloc(opened.size + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead !== opened.size) return
      bytes = bytes.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
    await assertSafePath(path)
    signal?.throwIfAborted()
    const record = recordSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    )
    const { integrity, ...payload } = record
    if (
      integrity !== hash(canonical(payload)) ||
      record.source !== source ||
      (expectedDescriptor &&
        canonical(record.descriptor) !== canonical(expectedDescriptor)) ||
      cachePath(directory, source, record.descriptor) !== path
    )
      return
    const descriptor = record.descriptor
    if (
      record.catalog.source !== source ||
      record.catalog.id !== descriptor.id ||
      record.catalog.name !== descriptor.name
    )
      return
    if (Date.parse(record.checkedAt) > Date.now() + 60_000) return
    const keys = [
      ...record.catalog.kits.map((item) => item.key),
      ...record.catalog.unavailableKits.map((item) => item.key),
    ]
    if (
      keys.length > 500 ||
      keys.some((key) => !key) ||
      new Set(keys).size !== keys.length ||
      record.catalog.unavailableKits.some(
        (item) =>
          !item.id ||
          !/^[a-z0-9][a-z0-9-]*$/.test(item.id) ||
          item.key !== `${descriptor.id}/${item.id}`,
      )
    )
      return
    let total = 0
    if (Object.keys(record.blobs).length > 1500) return
    for (const [sha, data] of Object.entries(record.blobs)) {
      signal?.throwIfAborted()
      const bytes = Buffer.from(data, "base64")
      total += bytes.length
      if (
        bytes.length > 2 * 1024 * 1024 ||
        total > 32 * 1024 * 1024 ||
        bytes.toString("base64") !== data ||
        gitBlobHash(bytes) !== sha
      )
        return
    }
    for (const item of record.catalog.kits) {
      const remote = item.origin.remote
      if (
        item.key !== `${descriptor.id}/${item.kit.id}` ||
        item.origin.source !== source ||
        item.origin.scope !== "global" ||
        item.origin.repository !== undefined ||
        item.origin.file !== undefined ||
        item.origin.catalogId !== descriptor.id ||
        !item.origin.contentHash ||
        !remote ||
        remote.repo !== descriptor.repo ||
        remote.ref !== descriptor.ref ||
        remote.directory !== descriptor.directory ||
        remote.commit !== record.commit ||
        !remote.skillPaths?.length ||
        item.kit.questions.length ||
        item.kit.outputs.some(
          (output) => output.type !== "skill" || output.when,
        )
      )
        return
      if (remote.skillPaths.length !== item.kit.outputs.length) return
      if (descriptor.kits) {
        const choice = descriptor.kits.find(
          (choice) => choice.id === item.kit.id,
        )
        if (
          !choice ||
          item.kit.name !== choice.name ||
          canonical(remote.skillPaths) !==
            canonical(choice.skills.map((skill) => skill.path))
        )
          return
      } else {
        if (remote.skillPaths.length !== 1) return
        const path = remote.skillPaths[0]!
        if (
          descriptor.directory &&
          path !== descriptor.directory &&
          !path.startsWith(`${descriptor.directory}/`)
        )
          return
        if (path === ".") {
          if (
            descriptor.directory ||
            item.kit.id !== "skill" ||
            item.kit.name !== descriptor.repo.split("/")[1]
          )
            return
        } else {
          const prefix = descriptor.directory ? `${descriptor.directory}/` : ""
          const relative = path.slice(prefix.length) || path.split("/").at(-1)!
          const slug =
            relative
              .toLowerCase()
              .replace(/[^a-z0-9-]+/g, "-")
              .replace(/^-+|-+$/g, "") || "skill"
          const suffix = hash(relative).slice(0, 12)
          if (
            item.kit.name !== relative ||
            item.kit.id !== `${slug.slice(0, 180)}-${suffix}`
          )
            return
        }
      }
      for (const output of item.kit.outputs) {
        if (
          output.type !== "skill" ||
          !remote.skillPaths.some(
            (path) =>
              (path === "."
                ? descriptor.repo.split("/")[1]
                : path.split("/").at(-1)) === output.name,
          )
        )
          return
      }
    }
    return record
  } catch {
    signal?.throwIfAborted()
    return
  }
}

/** Atomic private files; eviction is restricted to this helper's exact owned names. */
export async function writeRemoteCache(
  directory: string | undefined,
  record: Omit<RemoteCacheRecord, "integrity">,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted()
  if (!directory) return
  let temporary: string | undefined
  try {
    const payload = recordSchema.omit({ integrity: true }).parse(record)
    const { kind, source, checkedAt, ...rest } = payload
    const bytes = Buffer.from(
      JSON.stringify({
        kind,
        source,
        checkedAt,
        ...rest,
        integrity: hash(canonical(payload)),
      }),
    )
    if (bytes.length > maxEntry)
      return "Remote catalog is too large to persist in the browse cache"
    await assertSafeDirectory(directory)
    signal?.throwIfAborted()
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await assertSafeDirectory(directory)
    signal?.throwIfAborted()
    const path = cachePath(directory, record.source, record.descriptor)
    await assertSafePath(path)
    signal?.throwIfAborted()
    temporary = `${path}.${randomUUID()}.tmp`
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    )
    try {
      signal?.throwIfAborted()
      await handle.writeFile(bytes)
      signal?.throwIfAborted()
      await handle.sync()
    } finally {
      await handle.close()
    }
    await assertSafeDirectory(directory)
    await assertSafePath(path)
    signal?.throwIfAborted()
    await rename(temporary, path)
    temporary = undefined
    signal?.throwIfAborted()
    const owned = []
    for (const name of await readdir(directory)) {
      signal?.throwIfAborted()
      if (!filename.test(name)) continue
      const path = join(directory, name)
      const info = await lstat(path)
      if (info.isFile()) owned.push({ path, size: info.size, at: info.mtimeMs })
    }
    owned.sort((a, b) => b.at - a.at)
    let total = 0
    for (let i = 0; i < owned.length; i++) {
      signal?.throwIfAborted()
      const item = owned[i]!
      total += item.size
      if (i >= 16 || total > maxTotal) {
        await assertSafeDirectory(directory)
        await assertSafePath(item.path)
        signal?.throwIfAborted()
        await unlink(item.path)
      }
    }
  } catch {
    signal?.throwIfAborted()
    return "Remote browse cache is unavailable; live catalog loading is unaffected"
  } finally {
    if (temporary) {
      try {
        await assertSafeDirectory(directory)
        await unlink(temporary)
      } catch {
        /* disposable temporary file */
      }
    }
  }
}

export function cachedCatalog(
  record: RemoteCacheRecord,
  permanent: boolean,
  status: "cached" | "fresh" | "stale",
  reason?: string,
): Catalog {
  return {
    ...structuredClone(record.catalog),
    permanent,
    automatic: permanent,
    cache: {
      status,
      checkedAt: record.checkedAt,
      ...(reason ? { reason } : {}),
    },
  }
}
