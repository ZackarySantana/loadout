import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { parseDocument } from "yaml"
import { z } from "zod"
import { canonical } from "../domain/content"
import {
  kitSchema,
  type Catalog,
  type CatalogOrigin,
  type LoadedKit,
} from "../domain/kit"
import {
  remoteSkillsSourceSchema,
  type RemoteSkillsSource,
} from "../domain/catalog-source"

export interface CatalogLoadOptions {
  hydrateSources?: string[]
  installed?: LoadedKit[]
  forceRefresh?: boolean
}

const defaults: RemoteSkillsSource[] = [
  {
    type: "remote-skills",
    id: "matt-pocock",
    name: "Matt Pocock",
    repo: "mattpocock/skills",
    directory: "skills",
    license: "LICENSE",
  },
  {
    type: "remote-skills",
    id: "anthropic",
    name: "Anthropic",
    repo: "anthropics/skills",
    directory: "skills",
  },
  {
    type: "remote-skills",
    id: "ponytail",
    name: "Ponytail",
    repo: "DietrichGebert/ponytail",
    directory: "skills",
    license: "LICENSE",
  },
]
declare const LOADOUT_BUNDLED: boolean
export const defaultRemoteSources = defaults.map((source) =>
  fileURLToPath(
    new URL(
      `${typeof LOADOUT_BUNDLED !== "undefined" && LOADOUT_BUNDLED ? "../" : "../../"}catalog/remote/${source.id}.json`,
      import.meta.url,
    ),
  ),
)
const defaultDescriptors = new Map(
  defaultRemoteSources.map((source, i) => [source, defaults[i]!]),
)
export function isDefaultRemoteSource(source: string): boolean {
  return defaultDescriptors.has(source)
}
export function defaultRemoteDescriptor(
  source: string,
): RemoteSkillsSource | undefined {
  return defaultDescriptors.get(source)
}

/** Raw bytes and length-framed paths, never Git object IDs, dates, or HTTP validators. */
export function contentHash(
  files: Record<string, Uint8Array>,
  semantics?: unknown,
): string {
  const hash = createHash("sha256")
  const frame = (bytes: Uint8Array) => {
    hash.update(`${bytes.length}:`)
    hash.update(bytes)
  }
  if (semantics !== undefined) frame(Buffer.from(canonical(semantics)))
  for (const path of Object.keys(files).sort()) {
    frame(Buffer.from(path))
    frame(files[path]!)
  }
  return hash.digest("hex")
}

export function githubSource(source: string): RemoteSkillsSource | undefined {
  if (!source.startsWith("https://")) return
  const url = new URL(source)
  if (url.hostname !== "github.com") return
  if (
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use an HTTPS GitHub repository/directory URL without credentials, query, or fragment",
    )
  const parts = url.pathname
    .replace(/\/$/, "")
    .slice(1)
    .split("/")
    .map(decodeURIComponent)
  if (
    parts.length < 2 ||
    (parts.length > 2 && (parts[2] !== "tree" || !parts[3]))
  )
    throw new Error(
      "Use a GitHub repository URL or /tree/ref/directory; refs containing slashes require a Remote skills descriptor",
    )
  const repo = `${parts[0]}/${parts[1]}`
  const directory = parts.length > 4 ? parts.slice(4).join("/") : undefined
  const identity = createHash("sha256")
    .update(`${repo.toLowerCase()}/${directory ?? ""}`)
    .digest("hex")
    .slice(0, 16)
  return remoteSkillsSourceSchema.parse({
    type: "remote-skills",
    id: `remote-${identity}`,
    name: repo,
    repo,
    ...(parts[3] ? { ref: parts[3] } : {}),
    ...(directory ? { directory } : {}),
  })
}

const maxFile = 2 * 1024 * 1024
const maxKit = 8 * 1024 * 1024
const maxCatalog = 32 * 1024 * 1024
const maxFiles = 200
const ttl = 60_000
// Shared across every adapter operation; cached reads never acquire a slot.
let activeRequests = 0
const requestQueue: {
  signal: AbortSignal
  grant: () => void
  abort: () => void
}[] = []
function releaseRequest(): void {
  activeRequests--
  while (requestQueue.length) {
    const next = requestQueue.shift()!
    next.signal.removeEventListener("abort", next.abort)
    if (next.signal.aborted) {
      next.abort()
      continue
    }
    activeRequests++
    next.grant()
    break
  }
}
function acquireRequest(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted()
  if (activeRequests < 6) {
    activeRequests++
    return Promise.resolve(releaseRequest)
  }
  return new Promise((resolve, reject) => {
    const waiting = {
      signal,
      grant: () => resolve(releaseRequest),
      abort: () => {
        const index = requestQueue.indexOf(waiting)
        if (index !== -1) requestQueue.splice(index, 1)
        signal.removeEventListener("abort", waiting.abort)
        reject(signal.reason)
      },
    }
    requestQueue.push(waiting)
    signal.addEventListener("abort", waiting.abort, { once: true })
  })
}
const cache = new Map<
  string,
  { at: number; value: Promise<Buffer>; size?: number }
>()
function cached(
  key: string,
  fresh: boolean,
  action: () => Promise<Buffer>,
): Promise<Buffer> {
  for (const [key, entry] of cache)
    if (Date.now() - entry.at >= ttl) cache.delete(key)
  const saved = cache.get(key)
  if (!fresh && saved && Date.now() - saved.at < ttl) return saved.value
  if (cache.size >= 128) cache.delete(cache.keys().next().value!)
  const value = action()
  cache.set(key, { at: Date.now(), value })
  void value.then(
    (bytes) => {
      const entry = cache.get(key)
      if (entry?.value !== value) return
      entry.size = bytes.length
      let size = [...cache.values()].reduce(
        (sum, item) => sum + (item.size ?? 0),
        0,
      )
      for (const [oldKey, old] of cache) {
        if (size <= 64 * 1024 * 1024) break
        size -= old.size ?? 0
        cache.delete(oldKey)
      }
    },
    () => {
      if (cache.get(key)?.value === value) cache.delete(key)
    },
  )
  return value
}
const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z
    .array(
      z.object({
        path: z.string(),
        mode: z.string(),
        type: z.string(),
        sha: z.string().regex(/^[a-f0-9]{40}$/),
        size: z.number().int().nonnegative().optional(),
      }),
    )
    .max(30_000),
})
type Entry = z.infer<typeof treeSchema>["tree"][number]
const safePath = (path: string) =>
  path.length <= 1024 &&
  !/[\\\x00-\x1f\x7f-\x9f\u2028\u2029\ud800-\udfff]/u.test(path) &&
  path.split("/").every((part) => !!part && part !== "." && part !== "..")
const encodePath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/")
function text(bytes: Uint8Array): string {
  const result = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes)
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result))
    throw new Error(
      "Binary/control-containing files cannot be represented as skill text",
    )
  return result
}
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function skillDirectoryName(path: string, repo: string): string {
  return path === "." ? repo.split("/")[1]! : path.split("/").at(-1)!
}

/** Conservative portable check, not a claim to model every filesystem's Unicode rules. */
function assertPortableTargets(paths: string[]): void {
  const nodes = new Map<string, { path: string; directory: boolean }>()
  for (const path of paths) {
    const parts = path.split("/")
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/")
      const folded = prefix.normalize("NFC").toLowerCase()
      const directory = i < parts.length
      const previous = nodes.get(folded)
      if (
        previous &&
        (previous.path !== prefix ||
          previous.directory !== directory ||
          !directory)
      )
        throw new Error(
          `Case-folded or file/directory target collision: ${previous.path} and ${prefix}`,
        )
      nodes.set(folded, { path: prefix, directory })
    }
  }
}

export function remoteCatalogHeader(
  source: string,
  descriptor: RemoteSkillsSource,
  permanent = false,
): Catalog {
  return {
    id: descriptor.id,
    name: descriptor.name,
    source,
    permanent,
    automatic: permanent,
    kind: "remote",
    hydration: "deferred",
    kits: [],
    unavailableKits: [],
    issues: [],
  }
}

export async function loadRemoteCatalog(
  source: string,
  descriptor: RemoteSkillsSource,
  permanent = false,
  origin?: CatalogOrigin,
  options: CatalogLoadOptions = {},
): Promise<Catalog> {
  descriptor = remoteSkillsSourceSchema.parse(descriptor)
  const catalog = remoteCatalogHeader(source, descriptor, permanent)
  const browse =
    options.hydrateSources === undefined ||
    options.hydrateSources.includes(source)
  const installed = (options.installed ?? []).filter(
    (item) =>
      item.origin?.source === source &&
      item.key.startsWith(`${descriptor.id}/`),
  )
  if (!browse && !installed.length) return catalog
  const fresh = options.forceRefresh ?? false
  const signal = AbortSignal.timeout(90_000)
  // Per-operation deduplication also applies when bypassing the shared TTL cache.
  const pending = new Map<string, Promise<Buffer>>()
  let downloaded = 0
  let received = 0
  let catalogBudgetError: Error | undefined
  const exhaustBudget = () =>
    (catalogBudgetError ??= new Error(
      "Remote catalog exceeds 32 MiB; narrow its descriptor directory or kit selection",
    ))
  const assertBudget = () => {
    if (catalogBudgetError) throw catalogBudgetError
    if (downloaded >= maxCatalog || received >= maxCatalog)
      throw exhaustBudget()
  }
  let requests = 0
  const get = async (url: string, limit: number): Promise<Buffer> => {
    // Exhaustion is permanent for this operation, including cached/pending reads.
    assertBudget()
    const parsed = new URL(url)
    if (
      !["https://api.github.com", "https://raw.githubusercontent.com"].includes(
        parsed.origin,
      ) ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    )
      throw new Error("Unsafe GitHub request URL")
    if (++requests > 1500)
      throw new Error("Remote catalog request limit exceeded")
    signal.throwIfAborted()
    let request = pending.get(url)
    if (!request) {
      request = cached(`bytes:${url}`, fresh, async () => {
        const release = await acquireRequest(signal)
        try {
          // A queued request may have exhausted its budget while awaiting a slot.
          assertBudget()
          signal.throwIfAborted()
          const response = await fetch(url, {
            cache: "no-store",
            redirect: "error",
            headers: {
              Accept: "application/vnd.github+json",
              "User-Agent": "loadout",
            },
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          })
          if (!response.ok || !response.body) {
            await response.body?.cancel()
            throw new Error(
              `GitHub HTTP ${response.status}: ${url}${response.status === 403 || response.status === 429 ? "; public API rate limit may apply" : ""}`,
            )
          }
          const reader = response.body.getReader()
          const chunks: Uint8Array[] = []
          let size = 0
          try {
            while (true) {
              if (catalogBudgetError) throw catalogBudgetError
              const { done, value } = await reader.read()
              if (done) break
              // Count failed/oversized responses too. Already-active requests can
              // overshoot only by their current body chunks (at most six globally),
              // never by successive batches. Each reader is cancelled below.
              received += value.length
              if (received > maxCatalog) throw exhaustBudget()
              size += value.length
              if (size > limit)
                throw new Error(`Remote file exceeds ${limit} bytes`)
              chunks.push(value)
            }
          } finally {
            await reader.cancel()
          }
          return Buffer.concat(chunks)
        } finally {
          release()
        }
      })
      pending.set(url, request)
    }
    const bytes = await request
    if (catalogBudgetError) throw catalogBudgetError
    if (bytes.length > limit)
      throw new Error(`Remote file exceeds ${limit} bytes`)
    if (downloaded + bytes.length > maxCatalog) throw exhaustBudget()
    downloaded += bytes.length
    return bytes
  }
  const api = `https://api.github.com/repos/${descriptor.repo}`
  const commit = z
    .object({
      sha: z.string().regex(/^[a-f0-9]{40}$/),
      commit: z.object({
        committer: z.object({ date: z.string().datetime({ offset: true }) }),
      }),
    })
    .parse(
      JSON.parse(
        text(
          await get(
            `${api}/commits/${encodeURIComponent(descriptor.ref ?? "HEAD")}`,
            maxFile,
          ),
        ),
      ),
    )
  const tree = treeSchema.parse(
    JSON.parse(
      text(
        await get(
          `${api}/git/trees/${commit.sha}?recursive=1`,
          8 * 1024 * 1024,
        ),
      ),
    ),
  )
  // GitHub recursive trees are not paginated. Never treat a truncated response as complete.
  if (tree.truncated)
    throw new Error(
      "GitHub returned a truncated repository tree; skill inventory cannot be safely enumerated",
    )
  if (tree.tree.some((entry) => !safePath(entry.path)))
    throw new Error("GitHub tree contains an unsafe path")
  if (new Set(tree.tree.map((entry) => entry.path)).size !== tree.tree.length)
    throw new Error("GitHub tree contains duplicate paths")
  const entries = new Map(tree.tree.map((entry) => [entry.path, entry]))
  type Choice = {
    id: string
    name: string
    skills: { path: string; license?: string }[]
  }
  let choices: Choice[]
  if (descriptor.kits) choices = descriptor.kits
  else if (!browse)
    choices = installed
      .filter((item) => {
        const paths = item.origin?.remote?.skillPaths
        if (!paths?.length) return true
        return paths.every(
          (path) =>
            (!descriptor.directory ||
              path.startsWith(`${descriptor.directory}/`) ||
              path === descriptor.directory) &&
            entries.has(path === "." ? "SKILL.md" : `${path}/SKILL.md`),
        )
      })
      .map((item) => ({
        id: item.kit.id,
        name: item.kit.name,
        skills: (item.origin?.remote?.skillPaths ?? []).map((path) => ({
          path,
        })),
      }))
  else {
    const prefix = descriptor.directory ? `${descriptor.directory}/` : ""
    choices = tree.tree
      .filter(
        (entry) =>
          entry.path.startsWith(prefix) && entry.path.endsWith("/SKILL.md"),
      )
      .map((entry) => {
        const path = entry.path.slice(0, -"/SKILL.md".length)
        const relative = path.slice(prefix.length) || path.split("/").at(-1)!
        const slug =
          relative
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "skill"
        // Directory identity survives frontmatter edits, but not directory renames.
        // Hashing the exact path also distinguishes case/punctuation and flattened paths.
        const suffix = createHash("sha256")
          .update(relative)
          .digest("hex")
          .slice(0, 12)
        return {
          id: `${slug.slice(0, 180)}-${suffix}`,
          name: relative,
          skills: [{ path }],
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))
    // A single skill at repository root is also a valid direct source.
    if (!descriptor.directory && entries.has("SKILL.md"))
      choices.unshift({
        id: "skill",
        name: descriptor.repo.split("/")[1]!,
        skills: [{ path: "." }],
      })
  }
  if (choices.length > 500)
    throw new Error(
      "Remote catalog exceeds 500 skills; narrow the descriptor directory",
    )
  const counts = new Map<string, number>()
  for (const choice of choices)
    counts.set(choice.id, (counts.get(choice.id) ?? 0) + 1)
  // Metadata-only inventory suffices to detect incompatible native output names,
  // even when checking just one installed key rather than downloading its siblings.
  const outputCounts = new Map<string, number>()
  const inventoryPaths = descriptor.kits
    ? descriptor.kits.flatMap((kit) => kit.skills.map((skill) => skill.path))
    : tree.tree
        .filter(
          (entry) =>
            (entry.path.endsWith("/SKILL.md") &&
              (!descriptor.directory ||
                entry.path.startsWith(`${descriptor.directory}/`))) ||
            (!descriptor.directory && entry.path === "SKILL.md"),
        )
        .map((entry) =>
          entry.path === "SKILL.md"
            ? "."
            : entry.path.slice(0, -"/SKILL.md".length),
        )
  for (const path of inventoryPaths) {
    const name = skillDirectoryName(path, descriptor.repo)
      .normalize("NFC")
      .toLowerCase()
    outputCounts.set(name, (outputCounts.get(name) ?? 0) + 1)
  }
  if (!browse)
    choices = choices.filter((choice) =>
      installed.some((item) => item.kit.id === choice.id),
    )
  for (const choice of choices) {
    const key = `${descriptor.id}/${choice.id}`
    try {
      if (counts.get(choice.id)! > 1)
        throw new Error(
          "Conflicting skill directory IDs; use a curated descriptor to assign unique IDs",
        )
      if (!choice.skills.length)
        throw new Error(
          "Installed snapshot lacks upstream skill paths; browse the source to check this kit",
        )
      const rawFiles: Record<string, Uint8Array> = Object.create(null)
      const outputs: {
        type: "skill"
        name: string
        files: Record<string, string>
      }[] = []
      let total = 0
      let count = 0
      let description = ""
      for (const skill of choice.skills) {
        if (skill.path !== "." && !safePath(skill.path))
          throw new Error("Unsafe skill directory")
        const outputName = skillDirectoryName(skill.path, descriptor.repo)
        if (!/^[a-z0-9][a-z0-9-]*$/.test(outputName))
          throw new Error(
            `Skill directory basename must be a valid native skill name: ${outputName}`,
          )
        if (
          (outputCounts.get(outputName.normalize("NFC").toLowerCase()) ?? 0) > 1
        )
          throw new Error(
            `Conflicting native skill directory name ${outputName}; narrow the descriptor to non-conflicting skill directories`,
          )
        // Reject a symlink/submodule ancestor, not just its children.
        const ancestors =
          skill.path === "."
            ? []
            : skill.path
                .split("/")
                .map((_, i, parts) => parts.slice(0, i + 1).join("/"))
        if (
          ancestors.some(
            (path) =>
              entries.get(path)?.type !== "tree" ||
              entries.get(path)?.mode !== "040000",
          )
        )
          throw new Error(`Missing or non-directory skill path: ${skill.path}`)
        const prefix = skill.path === "." ? "" : `${skill.path}/`
        const selected: { entry: Entry; target: string }[] = tree.tree
          .filter(
            (entry) => entry.path.startsWith(prefix) && entry.type !== "tree",
          )
          .map((entry) => ({ entry, target: entry.path.slice(prefix.length) }))
        const hasOwnLicense = selected.some(({ target }) =>
          /^licen[cs]e(?:\.[^/]*)?$/i.test(target),
        )
        const license =
          skill.license ?? (hasOwnLicense ? undefined : descriptor.license)
        if (license && !selected.some(({ entry }) => entry.path === license)) {
          const entry = entries.get(license)
          if (!entry)
            throw new Error(`Missing declared upstream license: ${license}`)
          if (
            selected.some(
              ({ target }) => target.toLowerCase() === "license.upstream",
            )
          )
            throw new Error(
              "License sidecar collides with upstream LICENSE.upstream",
            )
          selected.push({ entry, target: "LICENSE.upstream" })
        }
        if (!selected.some(({ target }) => target === "SKILL.md"))
          throw new Error("Missing SKILL.md")
        assertPortableTargets(selected.map(({ target }) => target))
        for (const { entry, target } of selected) {
          if (
            !safePath(target) ||
            entry.type !== "blob" ||
            !["100644", "100755"].includes(entry.mode)
          )
            throw new Error(
              `Unsupported symlink, submodule, or special file: ${entry.path}`,
            )
          if (entry.size === undefined || entry.size > maxFile)
            throw new Error(`Oversized/unknown-size skill file: ${entry.path}`)
          total += entry.size
          if (++count > maxFiles || total > maxKit)
            throw new Error(
              "Skill kit exceeds 200 files or 8 MiB; no files were omitted",
            )
        }
        const files: Record<string, string> = Object.create(null)
        for (let start = 0; start < selected.length; start += 6) {
          const results = await Promise.allSettled(
            selected.slice(start, start + 6).map(async ({ entry, target }) => {
              const bytes = await get(
                `https://raw.githubusercontent.com/${descriptor.repo}/${commit.sha}/${encodePath(entry.path)}`,
                maxFile,
              )
              if (bytes.length !== entry.size)
                throw new Error(`GitHub content size mismatch: ${entry.path}`)
              try {
                return { target, bytes, content: text(bytes) }
              } catch (error) {
                throw new Error(
                  `Cannot adapt upstream resource ${entry.path}: expected UTF-8 text; ${reason(error)}`,
                )
              }
            }),
          )
          const failure = results.find((result) => result.status === "rejected")
          if (failure?.status === "rejected") throw failure.reason
          for (const result of results) {
            if (result.status !== "fulfilled") continue
            const { target, bytes, content } = result.value
            files[target] = content
            rawFiles[`${skill.path}/${target}`] = bytes
          }
        }
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
          files["SKILL.md"]!,
        )
        if (!match)
          throw new Error("SKILL.md requires name and description frontmatter")
        const doc = parseDocument(match[1]!, { uniqueKeys: true })
        if (doc.errors.length) throw new Error("Invalid SKILL.md frontmatter")
        const meta = z
          .object({
            name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
            description: z.string().min(1),
          })
          .parse(doc.toJS({ maxAliasCount: 20 }))
        if (!description) description = meta.description
        if (meta.name !== outputName)
          throw new Error(
            `SKILL.md name ${meta.name} must match its directory basename ${outputName}; upstream bytes are never rewritten`,
          )
        outputs.push({ type: "skill", name: outputName, files })
      }
      if (new Set(outputs.map((output) => output.name)).size !== outputs.length)
        throw new Error("Duplicate skill output names")
      const displayName = choice.name
      const kit = kitSchema.parse({
        id: choice.id,
        name: displayName,
        description,
        questions: [],
        outputs,
      })
      const hash = contentHash(rawFiles, {
        id: choice.id,
        name: displayName,
        outputs: outputs.map((output) => ({ name: output.name })),
      })
      catalog.kits.push({
        key,
        kit,
        origin: {
          ...(origin ?? { source, scope: "global" }),
          catalogId: descriptor.id,
          contentHash: hash,
          remote: {
            repo: descriptor.repo,
            ...(descriptor.ref ? { ref: descriptor.ref } : {}),
            ...(descriptor.directory
              ? { directory: descriptor.directory }
              : {}),
            skillPaths: choice.skills.map((skill) => skill.path),
            commit: commit.sha,
            upstreamCommitDate: commit.commit.committer.date,
            retrievedAt: new Date().toISOString(),
          },
        },
      })
    } catch (error) {
      const failure = reason(error)
      catalog.unavailableKits!.push({
        key,
        id: choice.id,
        name: choice.name,
        source: choice.skills.map((skill) => skill.path).join(", "),
        reason: failure,
      })
      catalog.issues!.push(`${key}: ${failure}`)
    }
  }
  catalog.hydration = browse ? "loaded" : "partial"
  return catalog
}
