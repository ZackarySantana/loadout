import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, lstat, open, opendir, realpath } from "node:fs/promises"
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { compareAppVersions, isAppVersion } from "../domain/app-update"
import {
  SELF_UPDATE_NONCE_ENV,
  formatSelfUpdateCommand,
  type SelfUpdateAvailability,
  type SelfUpdateSelection,
  type UpdateInstaller,
} from "../domain/self-update"

export type SelfUpdateContext = {
  packageRoot: string
  version: string
  nodePath: string
  cwd: string
  home: string
  environment: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** Launcher-derived, resolved --repo path; never accepted from update IPC. */
  repository?: string
}

export type ValidatedSelfUpdateInstallation = {
  packageRoot: string
  version: string
  entry: string
}

const packageName = "@lidtop/loadout"
const registry = "https://registry.npmjs.org/"
const maxBytes = 128 * 1024
const manual =
  "Update manually using the installer that owns this installation."
const unavailable = `No supported global Mise or npm installation was verified. ${manual}`
const windowsManual =
  "Automatic updates are unavailable on Windows because subprocess-tree cancellation cannot be guaranteed. Update Loadout manually after exiting."

type Tool = { file: string; args: string[]; installer: UpdateInstaller }
type Prepared = {
  current: ValidatedSelfUpdateInstallation
  home: string
  nodePath: string
  environment: NodeJS.ProcessEnv
  directories: string[]
  excluded: string[]
  signal?: AbortSignal
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function contained(root: string, path: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value
  const rest = relative(normalize(root), normalize(path))
  return (
    rest === "" ||
    (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`))
  )
}

function active(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new Error("Application update cancelled. No restart was attempted.")
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

async function hasMarker(directory: string, names: string[]): Promise<boolean> {
  const found = await Promise.all(
    names.map((name) => exists(join(directory, name))),
  )
  return found.some(Boolean)
}

async function regularFile(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Unsupported linked or non-regular installation file.")
}

async function readManifest(path: string): Promise<Record<string, unknown>> {
  await regularFile(path)
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes)
      throw new Error("Installation metadata is not a small regular file.")
    const buffer = Buffer.alloc(info.size + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead !== info.size)
      throw new Error("Installation metadata changed while reading.")
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, bytesRead),
      ),
    )
    if (!object(value)) throw new Error("Invalid installation metadata.")
    return value
  } finally {
    await handle.close()
  }
}

/** Startup validation also permits checkouts; it does not grant update ownership. */
export async function validateSelfUpdateInstallation(
  packageRoot: string,
  expectedVersion?: string,
): Promise<ValidatedSelfUpdateInstallation> {
  if (!isAbsolute(packageRoot))
    throw new Error("An absolute installation path is required.")
  const root = await realpath(packageRoot)
  if (!(await lstat(root)).isDirectory())
    throw new Error("The application package root is not a directory.")
  const manifest = await readManifest(join(root, "package.json"))
  if (
    manifest.name !== packageName ||
    !isAppVersion(manifest.version) ||
    (expectedVersion !== undefined && manifest.version !== expectedVersion)
  )
    throw new Error(
      "The installed package name or exact version did not match.",
    )
  const dist = join(root, "dist")
  const entry = join(dist, "cli.js")
  await regularFile(entry)
  if (!contained(root, await realpath(entry)))
    throw new Error("The application entry is outside its installation.")
  return { packageRoot: root, version: manifest.version, entry }
}

async function managedInstallation(
  packageRoot: string,
  expectedVersion: string,
): Promise<ValidatedSelfUpdateInstallation> {
  const info = await lstat(packageRoot)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(
      `Linked installations cannot update automatically. ${manual}`,
    )
  const installation = await validateSelfUpdateInstallation(
    packageRoot,
    expectedVersion,
  )
  if (await exists(join(installation.packageRoot, ".git")))
    throw new Error(`Source checkouts cannot update automatically. ${manual}`)
  const dist = await lstat(join(installation.packageRoot, "dist"))
  if (
    !dist.isDirectory() ||
    dist.isSymbolicLink() ||
    (await realpath(installation.entry)) !== installation.entry
  )
    throw new Error(
      `Linked application entries cannot update automatically. ${manual}`,
    )
  return installation
}

/** Exclude the whole enclosing project, not merely a monorepo's invocation folder. */
async function projectBoundary(cwd: string, home: string): Promise<string[]> {
  const markers = [
    ".git",
    ".hg",
    ".svn",
    "package.json",
    "pnpm-workspace.yaml",
    "lerna.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "node_modules",
    ".loadout",
    ".mise",
    ".mise.toml",
    "mise.toml",
    ".npmrc",
    ".tool-versions",
  ]
  let boundary: string | undefined
  let directory = cwd
  while (true) {
    // Home's npm/Mise configuration is explicitly trusted user-global policy.
    // A source project at home is not a safe neutral manager working directory.
    if (directory === home) {
      if (
        await hasMarker(home, [
          ".git",
          ".hg",
          ".svn",
          "package.json",
          "pyproject.toml",
          "Cargo.toml",
          "go.mod",
        ])
      )
        throw new Error(
          `The home directory is a project, not a neutral update directory. ${manual}`,
        )
      break
    }
    if (await hasMarker(directory, markers)) boundary = directory
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  if (cwd === home) return []
  if (!boundary)
    throw new Error(
      `The enclosing project boundary could not be verified. ${manual}`,
    )
  if (contained(boundary, home))
    throw new Error(
      `The home directory is inside the project trust boundary. ${manual}`,
    )
  return [boundary]
}

async function prepare(context: SelfUpdateContext): Promise<Prepared> {
  active(context.signal)
  // Node has no Windows job-object API. taskkill cannot safely recover a tree
  // after its parent exits, so do not start an automatically managed tree there.
  if (process.platform === "win32") throw new Error(windowsManual)
  const current = await managedInstallation(
    context.packageRoot,
    context.version,
  )
  if (
    !isAppVersion(context.version) ||
    !isAbsolute(context.cwd) ||
    !isAbsolute(context.home) ||
    !isAbsolute(context.nodePath) ||
    (context.repository !== undefined && !isAbsolute(context.repository))
  )
    throw new Error(`Unsupported update context. ${manual}`)
  const [cwd, home, nodePath, runningNode] = await Promise.all([
    realpath(context.cwd),
    realpath(context.home),
    realpath(context.nodePath),
    realpath(process.execPath),
  ])
  if (nodePath !== runningNode || !(await lstat(home)).isDirectory())
    throw new Error(
      `The running Node installation could not be verified. ${manual}`,
    )
  const repository = context.repository
    ? await realpath(context.repository)
    : undefined
  const excluded = [
    resolve(context.cwd),
    cwd,
    ...(await projectBoundary(cwd, home)),
    ...(resolve(context.cwd) === cwd
      ? []
      : await projectBoundary(resolve(context.cwd), resolve(context.home))),
    ...(context.repository && repository
      ? [
          resolve(context.repository),
          repository,
          ...(await projectBoundary(repository, home)),
          ...(resolve(context.repository) === repository
            ? []
            : await projectBoundary(
                resolve(context.repository),
                resolve(context.home),
              )),
        ]
      : []),
  ].filter((path) => path !== home && path !== resolve(context.home))
  const allowed = (path: string) =>
    !excluded.some((root) => contained(root, path))
  if (!allowed(home) || !allowed(nodePath))
    throw new Error(
      `The update runtime or home directory is inside the project. ${manual}`,
    )
  const environment = { ...context.environment }
  const pathKeys = Object.keys(environment).filter(
    (key) => key.toLowerCase() === "path",
  )
  const originalPath =
    pathKeys
      .map((key) => environment[key])
      .find((value) => value !== undefined) ?? ""
  const directories: string[] = []
  for (const path of originalPath.split(delimiter)) {
    if (!isAbsolute(path) || !allowed(resolve(path))) continue
    try {
      const physical = await realpath(path)
      if (!allowed(physical) || !(await lstat(physical)).isDirectory()) continue
      if (!directories.includes(physical)) directories.push(physical)
    } catch {
      // Missing, inaccessible, relative, and project-owned PATH entries are ignored.
    }
  }
  for (const key of pathKeys) delete environment[key]
  environment.PATH = directories.join(delimiter)
  environment.PWD = home
  for (const key of Object.keys(environment)) {
    if (
      [
        SELF_UPDATE_NONCE_ENV,
        "NODE_CHANNEL_FD",
        "NODE_CHANNEL_SERIALIZATION_MODE",
        "NODE_OPTIONS",
        "NODE_PATH",
        "BUN_OPTIONS",
        "INIT_CWD",
        "MISE_ORIGINAL_CWD",
        "MISE_PROJECT_ROOT",
        "MISE_ENV_FILE",
      ].includes(key.toUpperCase())
    )
      delete environment[key]
    // Preserve user-global configuration, but not a repository-selected config.
    if (
      [
        "npm_config_userconfig",
        "npm_config_globalconfig",
        "mise_config_file",
        "mise_global_config_file",
        "mise_config_dir",
      ].includes(key.toLowerCase())
    ) {
      const path = environment[key]
      if (!path || !isAbsolute(path) || !allowed(resolve(path)))
        delete environment[key]
      else {
        try {
          if (!allowed(await realpath(path))) delete environment[key]
        } catch {
          delete environment[key]
        }
      }
    }
  }
  // Both npm and Mise's npm backend must use the same public registry as preflight.
  for (const key of Object.keys(environment))
    if (
      ["npm_config_registry", "npm_config_@lidtop:registry"].includes(
        key.toLowerCase(),
      )
    )
      delete environment[key]
  environment.NPM_CONFIG_REGISTRY = registry
  environment["NPM_CONFIG_@lidtop:registry"] = registry
  // Documented ceiling semantics exclude the ceiling directory itself, including
  // home-local/environment configs and project .miserc files. Global/system
  // configuration remains enabled and is validated separately before each call.
  if (home.includes(delimiter))
    throw new Error(
      `The home path cannot be represented as a Mise ceiling. ${manual}`,
    )
  for (const key of Object.keys(environment))
    if (key.toUpperCase() === "MISE_CEILING_PATHS") delete environment[key]
  environment.MISE_CEILING_PATHS = home
  // Check default and explicitly selected config paths before starting a manager;
  // a trusted-looking home config must not symlink back into the excluded project.
  const configPaths = [
    join(home, ".npmrc"),
    join(home, ".mise.toml"),
    join(home, "mise.toml"),
    join(home, ".tool-versions"),
    join(home, ".config/mise"),
    join(home, ".config/mise/config.toml"),
    join(home, ".config/mise/config.override.toml"),
  ]
  for (const [key, value] of Object.entries(environment)) {
    if (
      [
        "xdg_config_home",
        "mise_config_dir",
        "mise_global_config_file",
        "mise_config_file",
        "mise_global_config_root",
        "mise_data_dir",
        "mise_state_dir",
        "mise_cache_dir",
        "mise_installs_dir",
        "npm_config_userconfig",
        "npm_config_globalconfig",
        "npm_config_prefix",
      ].includes(key.toLowerCase())
    ) {
      if (!value || !isAbsolute(value) || !allowed(resolve(value)))
        throw new Error(
          `An installer configuration path is inside or relative to the project. ${manual}`,
        )
      configPaths.push(value)
      if (key.toLowerCase() === "xdg_config_home")
        configPaths.push(
          join(value, "mise"),
          join(value, "mise/config.toml"),
          join(value, "mise/config.override.toml"),
        )
      if (key.toLowerCase() === "mise_config_dir")
        configPaths.push(
          join(value, "config.toml"),
          join(value, "config.override.toml"),
        )
    }
  }
  for (const path of configPaths) {
    if (await exists(path)) {
      if (!allowed(await realpath(path)))
        throw new Error(
          `An installer configuration resolves inside the project. ${manual}`,
        )
    }
  }
  active(context.signal)
  return {
    current,
    home,
    nodePath,
    environment,
    directories,
    excluded,
    signal: context.signal,
  }
}

async function executable(
  prepared: Prepared,
  name: "npm" | "mise",
): Promise<string> {
  active(prepared.signal)
  const filenames =
    process.platform === "win32"
      ? [`${name}.${name === "npm" ? "cmd" : "exe"}`]
      : [name]
  for (const directory of prepared.directories) {
    for (const filename of filenames) {
      const candidate = join(directory, filename)
      try {
        const physical = await realpath(candidate)
        if (prepared.excluded.some((root) => contained(root, physical)))
          continue
        await regularFile(physical)
        if (process.platform !== "win32") await access(physical, constants.X_OK)
        return physical
      } catch {
        // Only executables in trusted absolute PATH directories are candidates.
      }
    }
  }
  throw new Error(
    `${name === "mise" ? "Mise" : "npm"} was not found on a supported PATH. ${manual}`,
  )
}

/** Validate every physical global/system candidate before Mise can load any of it. */
async function validateMiseConfiguration(prepared: Prepared): Promise<void> {
  const environment = prepared.environment
  if (
    environment.MISE_ENV &&
    (environment.MISE_ENV.length > 1024 ||
      environment.MISE_ENV.split(",").some(
        (name) => !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(name),
      ))
  )
    throw new Error(
      `The selected Mise environment names are unsupported. ${manual}`,
    )
  const paths = [
    // Also inspect default roots when overridden: early .miserc discovery in
    // supported Mise releases need not share normal TOML override precedence.
    join(prepared.home, ".config/mise"),
    join(environment.XDG_CONFIG_HOME ?? join(prepared.home, ".config"), "mise"),
    environment.MISE_CONFIG_DIR,
    "/etc/mise",
    environment.MISE_SYSTEM_CONFIG_DIR,
    environment.MISE_SYSTEM_DIR,
    environment.MISE_GLOBAL_CONFIG_FILE,
    environment.MISE_CONFIG_FILE,
    environment.MISE_SYSTEM_CONFIG_FILE,
    // Older/asdf-compatible Mise can also read a global tool-versions file
    // independently of the project ceiling and global TOML config directory.
    resolve(
      prepared.home,
      environment.MISE_DEFAULT_TOOL_VERSIONS_FILENAME ?? ".tool-versions",
    ),
  ]
  const visited = new Set<string>()
  let count = 0
  const visit = async (path: string, depth: number): Promise<void> => {
    active(prepared.signal)
    if (++count > 2048 || depth > 12)
      throw new Error(
        `The Mise configuration tree is too large to verify safely. ${manual}`,
      )
    if (
      !isAbsolute(path) ||
      prepared.excluded.some((root) => contained(root, resolve(path)))
    )
      throw new Error(
        `Mise configuration is inside or relative to the project. ${manual}`,
      )
    if (!(await exists(path))) return
    const physical = await realpath(path)
    if (prepared.excluded.some((root) => contained(root, physical)))
      throw new Error(
        `Mise configuration resolves inside the project. ${manual}`,
      )
    if (visited.has(physical)) return
    visited.add(physical)
    const info = await lstat(physical)
    if (info.isDirectory()) {
      // Inspect every entry, not just today's filename patterns: local/env
      // variants, .miserc, conf.d files, folder fragments and future names.
      for await (const entry of await opendir(physical))
        await visit(join(physical, entry.name), depth + 1)
    } else if (!info.isFile())
      throw new Error(
        `Mise configuration contains an unsupported file type. ${manual}`,
      )
  }
  for (const path of paths) if (path !== undefined) await visit(path, 0)
}

async function resolveTool(
  prepared: Prepared,
  installer: UpdateInstaller,
): Promise<Tool> {
  const file = await executable(prepared, installer)
  if (installer === "mise") return { file, args: [], installer }
  // npm.cmd is not executable without a shell. Use only npm's known Node layout.
  const script =
    process.platform === "win32"
      ? join(dirname(file), "node_modules/npm/bin/npm-cli.js")
      : file
  const physical = await realpath(script)
  if (
    prepared.excluded.some((root) => contained(root, physical)) ||
    !physical.endsWith(`${sep}bin${sep}npm-cli.js`)
  )
    throw new Error(`This npm launcher layout is unsupported. ${manual}`)
  await regularFile(physical)
  const manifest = await readManifest(
    join(dirname(dirname(physical)), "package.json"),
  )
  if (manifest.name !== "npm")
    throw new Error(`The npm launcher could not be verified. ${manual}`)
  return { file: prepared.nodePath, args: [physical], installer }
}

/** Settle only after the child closes AND its private POSIX process group is gone. */
async function command(
  prepared: Prepared,
  tool: Tool,
  args: string[],
  interactive: boolean,
): Promise<string> {
  active(prepared.signal)
  if (process.platform === "win32") throw new Error(windowsManual)
  if (tool.installer === "mise") await validateMiseConfiguration(prepared)
  active(prepared.signal)
  return new Promise((resolve, reject) => {
    const child = spawn(tool.file, [...tool.args, ...args], {
      cwd: prepared.home,
      env: prepared.environment,
      stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
      shell: false,
      // The foreground launcher keeps the shell job alive; the manager and its
      // descendants share a separate session/group that can be terminated whole.
      detached: true,
    })
    let failure: Error | undefined
    let escalation: ReturnType<typeof setTimeout> | undefined
    let polling: ReturnType<typeof setInterval> | undefined
    let closed = false
    let finished = false
    let stopping = false
    let groupGone = child.pid === undefined
    const chunks: Buffer[] = []
    let bytes = 0
    const groupAlive = () => {
      if (groupGone || child.pid === undefined) return false
      try {
        process.kill(-child.pid, 0)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          groupGone = true
          return false
        }
        // EPERM is not proof that descendants have stopped. Fail closed and
        // retain supervision rather than allowing a restart during mutation.
        return true
      }
    }
    const signalGroup = (signal: NodeJS.Signals) => {
      if (groupGone || child.pid === undefined) return
      try {
        process.kill(-child.pid, signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") groupGone = true
        else
          failure ??= new Error(
            "The installer subprocess tree could not be stopped; waiting for it to terminate. No restart will be attempted.",
          )
      }
    }
    const finish = () => {
      if (finished || !closed || !groupGone) return
      finished = true
      if (timeout !== undefined) clearTimeout(timeout)
      if (escalation) clearTimeout(escalation)
      if (polling) clearInterval(polling)
      prepared.signal?.removeEventListener("abort", cancel)
      if (failure) reject(failure)
      else if (prepared.signal?.aborted)
        reject(
          new Error("Application update cancelled. No restart was attempted."),
        )
      else resolve(Buffer.concat(chunks).toString("utf8"))
    }
    const checkGroup = () => {
      if (!groupAlive()) {
        groupGone = true
        if (escalation) clearTimeout(escalation)
        if (polling) clearInterval(polling)
        finish()
      }
    }
    const stop = (force = false) => {
      if (!stopping) {
        stopping = true
        signalGroup(force ? "SIGKILL" : "SIGTERM")
        // Do not cancel escalation when only the manager exits: grandchildren
        // may still be in the group with inherited installer I/O handles.
        escalation = setTimeout(() => signalGroup("SIGKILL"), 2000)
        polling = setInterval(checkGroup, 25)
      } else if (force) signalGroup("SIGKILL")
      checkGroup()
    }
    const cancel = () => {
      failure = new Error(
        "Application update cancelled. No restart was attempted.",
      )
      stop()
    }
    const timeout = interactive
      ? undefined
      : setTimeout(() => {
          failure ??= new Error(`Installer inspection timed out. ${manual}`)
          stop(true)
        }, 3000)
    const collect = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length
      if (bytes > 32 * 1024) {
        failure ??= new Error(
          `Installer inspection output was too large. ${manual}`,
        )
        stop(true)
      } else if (stdout) chunks.push(chunk)
    }
    const superviseExit = () => {
      if (groupAlive()) {
        failure ??= new Error(
          "The installer left subprocesses running. Stopping the remaining tree; no restart will be attempted.",
        )
        stop()
      } else {
        groupGone = true
        finish()
      }
    }
    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, true))
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, false))
    child.once("error", () => {
      failure ??= new Error(
        "The installer could not start. No restart was attempted.",
      )
      stop(true)
    })
    // 'exit' precedes 'close' when descendants retain pipes. Supervise at exit,
    // otherwise waiting for close first could leave those descendants running.
    child.once("exit", superviseExit)
    child.once("close", (code, signal) => {
      closed = true
      if (code !== 0 || signal !== null)
        failure ??= new Error(
          interactive
            ? `The installer ${signal ? "was interrupted" : `failed (exit ${code ?? "unknown"})`}. No restart or rollback was attempted.`
            : `Installer ownership could not be verified. ${manual}`,
        )
      superviseExit()
    })
    prepared.signal?.addEventListener("abort", cancel, { once: true })
    if (prepared.signal?.aborted) cancel()
  })
}

function query(
  prepared: Prepared,
  tool: Tool,
  args: string[],
): Promise<string> {
  return command(prepared, tool, args, false)
}

function outputPath(output: string): string {
  const path = output.trim()
  if (!isAbsolute(path) || /[\x00-\x1f\x7f-\x9f]/.test(path))
    throw new Error(`The installer returned an unsupported path. ${manual}`)
  return path
}

async function miseInstallation(
  prepared: Prepared,
  tool: Tool,
  version: string,
): Promise<ValidatedSelfUpdateInstallation> {
  // `which --tool VERSION` proves installed presence, not global selection.
  // The supported tool-filtered ls JSON is an array of globally requested
  // version records; reject ambiguous, inactive, missing, and linked installs.
  const global: unknown = JSON.parse(
    await query(prepared, tool, [
      "ls",
      "--global",
      "--json",
      `npm:${packageName}`,
    ]),
  )
  const selected =
    Array.isArray(global) && global.length === 1 ? global[0] : undefined
  if (
    !object(selected) ||
    selected.version !== version ||
    selected.installed !== true ||
    selected.active !== true ||
    selected.symlinked_to !== undefined ||
    selected.broken === true ||
    selected.scheduled_for_pruning === true ||
    typeof selected.install_path !== "string" ||
    !isAbsolute(selected.install_path) ||
    !object(selected.source) ||
    selected.source.type !== "mise.toml" ||
    typeof selected.source.path !== "string" ||
    !isAbsolute(selected.source.path)
  )
    throw new Error(
      `Mise does not globally select this exact installation. ${manual}`,
    )
  const installInfo = await lstat(selected.install_path)
  if (!installInfo.isDirectory() || installInfo.isSymbolicLink())
    throw new Error(
      `The globally selected Mise installation is linked or unsupported. ${manual}`,
    )
  const [prefix, source] = await Promise.all([
    realpath(selected.install_path),
    realpath(selected.source.path),
  ])
  if (
    prepared.excluded.some(
      (root) => contained(root, prefix) || contained(root, source),
    )
  )
    throw new Error(
      `Mise global configuration resolves inside the project. ${manual}`,
    )
  const bin = await realpath(
    outputPath(
      await query(prepared, tool, [
        "which",
        "loadout",
        "--tool",
        `npm:${packageName}@${version}`,
      ]),
    ),
  )
  await regularFile(bin)
  // Only our published, fixed bin layouts qualify; never execute the returned path.
  const root = dirname(dirname(bin))
  if (!contained(prefix, root))
    throw new Error(
      `Mise's physical package is outside its selected installation. ${manual}`,
    )
  const installation = await managedInstallation(root, version)
  const manifest = await readManifest(
    join(installation.packageRoot, "package.json"),
  )
  if (
    !object(manifest.bin) ||
    typeof manifest.bin.loadout !== "string" ||
    !["dist/cli.js", "dist/launcher.js"].includes(manifest.bin.loadout) ||
    (await realpath(join(root, manifest.bin.loadout))) !== bin
  )
    throw new Error(
      `Mise did not resolve this application's physical bin. ${manual}`,
    )
  return installation
}

async function npmInstallation(
  prepared: Prepared,
  tool: Tool,
  version: string,
): Promise<ValidatedSelfUpdateInstallation> {
  const modules = outputPath(await query(prepared, tool, ["root", "--global"]))
  return managedInstallation(join(modules, "@lidtop", "loadout"), version)
}

async function ownedTool(
  prepared: Prepared,
  installer: UpdateInstaller,
): Promise<Tool> {
  const tool = await resolveTool(prepared, installer)
  const installation =
    installer === "mise"
      ? await miseInstallation(prepared, tool, prepared.current.version)
      : await npmInstallation(prepared, tool, prepared.current.version)
  if (installation.packageRoot !== prepared.current.packageRoot)
    throw new Error(
      `The selected installer does not own this installation. ${manual}`,
    )
  active(prepared.signal)
  return tool
}

/** Called only following an interactive, explicit request to choose an installer. */
export async function discoverOwnedInstallers(
  context: SelfUpdateContext,
): Promise<SelfUpdateAvailability> {
  if (process.platform === "win32")
    return { installers: [], reason: windowsManual }
  try {
    const prepared = await prepare(context)
    const installers: UpdateInstaller[] = ["mise", "npm"]
    const results = await Promise.all(
      installers.map(async (installer) => {
        try {
          await ownedTool(prepared, installer)
          return installer
        } catch {
          return undefined
        }
      }),
    )
    active(context.signal)
    const owned = results.filter(
      (value): value is UpdateInstaller => value !== undefined,
    )
    return {
      installers: owned,
      ...(!owned.length ? { reason: unavailable } : {}),
    }
  } catch {
    return { installers: [], reason: unavailable }
  }
}

function platformAllowed(value: unknown, current: string): boolean {
  if (value === undefined) return true
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some(
      (item) => typeof item !== "string" || !/^!?[a-z0-9_-]+$/.test(item),
    )
  )
    return false
  if (value.includes(`!${current}`) || value.includes("!any")) return false
  const positive = value.filter((item) => !item.startsWith("!"))
  return (
    !positive.length || positive.includes(current) || positive.includes("any")
  )
}

async function checkTarget(
  version: string,
  signal?: AbortSignal,
): Promise<void> {
  active(signal)
  const timeout = AbortSignal.timeout(4000)
  const response = await fetch(
    `${registry}@lidtop%2floadout/${encodeURIComponent(version)}`,
    {
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    },
  )
  if (!response.body)
    throw new Error("The exact update release could not be verified.")
  const reader = response.body.getReader()
  try {
    if (
      !response.ok ||
      Number(response.headers.get("content-length")) > maxBytes
    )
      throw new Error("The exact update release could not be verified.")
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      active(signal)
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > maxBytes)
        throw new Error("Update release metadata is too large.")
      chunks.push(chunk.value)
    }
    active(signal)
    const metadata: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    )
    if (
      !object(metadata) ||
      metadata.name !== packageName ||
      metadata.version !== version
    )
      throw new Error("The exact update package name or version did not match.")
    const engine = object(metadata.engines) ? metadata.engines.node : undefined
    const minimum =
      typeof engine === "string"
        ? /^>=(\d+\.\d+\.\d+)$/.exec(engine)
        : undefined
    if (
      !minimum ||
      minimum[0] !== engine ||
      !isAppVersion(minimum[1]) ||
      (compareAppVersions(process.versions.node, minimum[1]) ?? -1) < 0
    )
      throw new Error(
        "This release's Node requirement is unsupported or not satisfied. Update Node and Loadout manually.",
      )
    if (
      !platformAllowed(metadata.os, process.platform) ||
      !platformAllowed(metadata.cpu, process.arch)
    )
      throw new Error(
        "This release does not declare support for the current operating system or CPU.",
      )
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/** Caller must first close the UI child and receive its accepted update exit code. */
export async function performSelfUpdate(
  context: SelfUpdateContext,
  selection: SelfUpdateSelection,
): Promise<ValidatedSelfUpdateInstallation> {
  active(context.signal)
  if (
    !object(selection) ||
    Reflect.ownKeys(selection).length !== 2 ||
    !Object.hasOwn(selection, "installer") ||
    !Object.hasOwn(selection, "version") ||
    !["mise", "npm"].includes(selection.installer) ||
    !isAppVersion(selection.version)
  )
    throw new Error("Invalid application update selection.")
  const prepared = await prepare(context)
  if (
    (compareAppVersions(selection.version, prepared.current.version) ?? -1) <= 0
  )
    throw new Error(
      "The selected release is not newer than the current installation.",
    )
  // Only the selected manager is resolved or run. No alternate-manager fallback.
  await ownedTool(prepared, selection.installer)
  try {
    await checkTarget(selection.version, context.signal)
  } catch (error) {
    active(context.signal)
    if (
      error instanceof Error &&
      !["TypeError", "TimeoutError", "AbortError", "SyntaxError"].includes(
        error.name,
      )
    )
      throw error
    throw new Error(
      "The exact update release could not be verified online. Retry later or update manually.",
    )
  }
  // Network work must not permit a changed installation to become an implicit downgrade.
  await managedInstallation(context.packageRoot, context.version)
  const tool = await ownedTool(prepared, selection.installer)
  const args =
    selection.installer === "mise"
      ? ["use", "--global", `npm:${packageName}@${selection.version}`]
      : [
          "install",
          "--global",
          `${packageName}@${selection.version}`,
          "--ignore-scripts",
          "--registry",
          registry,
        ]
  active(context.signal)
  console.error(formatSelfUpdateCommand(selection))
  await command(prepared, tool, args, true)
  try {
    const installation =
      selection.installer === "mise"
        ? await miseInstallation(prepared, tool, selection.version)
        : await npmInstallation(prepared, tool, selection.version)
    active(context.signal)
    return installation
  } catch {
    active(context.signal)
    throw new Error(
      "The installer finished, but the exact new application entry could not be verified. No restart was attempted; inspect the installation manually.",
    )
  }
}
