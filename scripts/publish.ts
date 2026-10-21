import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const registry = "https://registry.npmjs.org/"

async function command(args: string[]): Promise<string> {
  const child = Bun.spawn(args, {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (status) throw new Error(`${args.join(" ")} failed: ${stderr}\n${stdout}`)
  if (stderr) console.error(stderr.trim())
  return stdout
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
  const response = await fetch(
    `${registry}${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`,
    { signal: AbortSignal.timeout(20_000) },
  )
  if (response.ok) {
    console.log(`Skipping published ${manifest.name}@${manifest.version}`)
    process.exit(0)
  }
  if (response.status !== 404)
    throw new Error(`Registry lookup failed: HTTP ${response.status}`)

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
  console.log(
    await command([
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
    ]),
  )
}
