import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const registry = "https://registry.npmjs.org/"

/** Captures output; `live` also echoes it as it arrives so slow registry calls are visible in CI. */
async function command(args: string[], live = false): Promise<string> {
  const child = Bun.spawn(args, {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const read = async (
    stream: ReadableStream<Uint8Array>,
    echo: NodeJS.WriteStream,
  ) => {
    let text = ""
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      if (live) echo.write(chunk)
      text += decoder.decode(chunk, { stream: true })
    }
    return text + decoder.decode()
  }
  const [stdout, stderr, status] = await Promise.all([
    read(child.stdout, process.stdout),
    read(child.stderr, process.stderr),
    child.exited,
  ])
  if (status) throw new Error(`${args.join(" ")} failed: ${stderr}\n${stdout}`)
  if (stderr && !live) console.error(stderr.trim())
  return stdout
}

/** Exact-version lookup that fails closed on anything except published or 404. */
async function isPublished(name: string, version: string) {
  const response = await fetch(
    `${registry}${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { signal: AbortSignal.timeout(20_000) },
  )
  if (response.ok) return true
  if (response.status !== 404)
    throw new Error(`Registry lookup failed: HTTP ${response.status}`)
  return false
}

const retryDelays = [5_000, 15_000]

/** Registry 5xx and network failures; auth, conflict, and validation errors are never retried. */
function transient(error: unknown) {
  return /\bcode E5\d\d\b|\b5\d\d (?:Service Unavailable|Bad Gateway|Gateway Time-?out|Internal Server Error)\b|\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|EPIPE)\b|socket hang up/i.test(
    String(error),
  )
}

const args = process.argv.slice(2)
if (args.some((arg) => arg !== "--publish" && arg !== "--dry-run"))
  throw new Error("Usage: bun scripts/publish.ts [--dry-run | --publish]")
if (args.includes("--publish") && args.includes("--dry-run"))
  throw new Error("Choose --publish or --dry-run")
const live = args.includes("--publish")

if (
  live &&
  (process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
)
  throw new Error(
    "Live publishing requires the main-branch GitHub Actions OIDC environment",
  )

const manifest = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
) as { name?: unknown; version?: unknown; private?: unknown }
if (manifest.name !== "@lidtop/loadout" || manifest.private)
  throw new Error("Expected the public @lidtop/loadout package")
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/
if (typeof manifest.version !== "string" || !semver.test(manifest.version))
  throw new Error("Package version must be valid semver")
const tag = manifest.version.split("+")[0]!.includes("-") ? "next" : "latest"

if (live) {
  if (manifest.version === "0.0.0") {
    console.log("Skipping placeholder 0.0.0; waiting for the first release PR")
    process.exit(0)
  }
  if (await isPublished(manifest.name, manifest.version)) {
    console.log(`Skipping published ${manifest.name}@${manifest.version}`)
    process.exit(0)
  }

  if (tag === "latest") {
    const latestResponse = await fetch(
      `${registry}${encodeURIComponent(manifest.name)}/latest`,
      { signal: AbortSignal.timeout(20_000) },
    )
    if (latestResponse.ok) {
      const latest = (await latestResponse.json()) as { version?: unknown }
      if (
        typeof latest.version !== "string" ||
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/.test(
          latest.version,
        )
      )
        throw new Error("npm latest must have a valid stable semver version")
      const current = manifest.version.split("+")[0]!.split(".").map(BigInt)
      const previous = latest.version.split("+")[0]!.split(".").map(BigInt)
      const difference = current.findIndex(
        (part, index) => part !== previous[index],
      )
      if (difference === -1 || current[difference]! < previous[difference]!)
        throw new Error(
          `Refusing to move npm latest backwards: choose a version greater than ${latest.version} and update the version baseline before using Changesets`,
        )
    } else if (latestResponse.status !== 404) {
      throw new Error(`npm latest lookup failed: HTTP ${latestResponse.status}`)
    }
  }

  const npmVersion = /^(\d+)\.(\d+)\.(\d+)$/.exec(
    (await command(["npm", "--version"])).trim(),
  )
  if (
    !npmVersion ||
    Number(npmVersion[1]) < 11 ||
    (Number(npmVersion[1]) === 11 &&
      (Number(npmVersion[2]) < 5 ||
        (Number(npmVersion[2]) === 5 && Number(npmVersion[3]) < 1)))
  )
    throw new Error("Publishing requires npm 11.5.1 or newer for OIDC")
}

await command(["npm", "run", "build"])
const tarballs = join(repositoryRoot, ".release/tarballs")
await mkdir(tarballs, { recursive: true })
const packed = JSON.parse(
  await command([
    "npm",
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    tarballs,
  ]),
) as { filename: string }[]
if (packed.length !== 1 || !packed[0]?.filename)
  throw new Error("Expected exactly one package tarball")
const tarball = join(tarballs, packed[0].filename)
if (!live) {
  console.log(
    `Packed ${manifest.name}@${manifest.version}: ${tarball} (not published)`,
  )
} else {
  // Bound npm's own per-request timeout and retries so a hung PUT fails in minutes, not tens of minutes.
  const publish = [
    "npm",
    "publish",
    tarball,
    "--access",
    "public",
    "--provenance",
    "--ignore-scripts",
    "--registry",
    registry,
    "--tag",
    tag,
    "--fetch-timeout",
    "120000",
    "--fetch-retries",
    "1",
  ]
  for (let attempt = 0; ; attempt++) {
    try {
      await command(publish, true)
      break
    } catch (error) {
      if (!transient(error)) throw error
      // A failed PUT may still have landed; never publish the same version twice.
      if (await isPublished(String(manifest.name), manifest.version)) {
        console.log(
          `${manifest.name}@${manifest.version} was published despite a registry error`,
        )
        break
      }
      const delay = retryDelays[attempt]
      if (delay === undefined) throw error
      console.error(
        `Transient registry failure publishing ${manifest.name}@${manifest.version}; retrying in ${delay / 1000}s`,
      )
      await Bun.sleep(delay)
    }
  }
}
