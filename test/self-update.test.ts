import { afterAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  formatSelfUpdateCommand,
  parseSelfUpdateChildMessage,
  parseSelfUpdateParentMessage,
  SELF_UPDATE_NONCE_ENV,
  type UpdateInstaller,
} from "../src/domain/self-update"

const currentVersion = "0.5.1"
const targetVersion = "0.6.0"
const nonce = "fixture-nonce"
const roots: string[] = []
const node = Bun.which("node")!

afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "loadout-self-update-"))
  roots.push(root)
  return root
}

async function installation(root: string, version = currentVersion) {
  await mkdir(join(root, "dist"), { recursive: true })
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@lidtop/loadout",
      version,
      type: "module",
      bin: { loadout: "dist/launcher.js" },
    }),
  )
  await writeFile(join(root, "dist/cli.js"), "// inert fixture entry\n")
  await writeFile(join(root, "dist/launcher.js"), "// never execute this bin\n")
}

type Event = { event: string; [key: string]: any }

async function events(path: string): Promise<Event[]> {
  try {
    return (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

// Each fixture runs in its own Node process: no mock.module or process-global
// fetch changes can leak into the existing suite. All PATH entries are fixtures.
async function run(
  entry: string,
  args: string[],
  options: {
    cwd: string
    env?: NodeJS.ProcessEnv
    interruptOn?: string
  },
) {
  const child = spawn(node, [entry, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env, NODE_OPTIONS: "" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  let interrupted = false
  const timeout = setTimeout(() => child.kill("SIGKILL"), 8000)
  child.stdout.on("data", (chunk) => {
    stdout += chunk
    if (
      options.interruptOn &&
      stdout.includes(options.interruptOn) &&
      !interrupted
    ) {
      interrupted = true
      child.kill("SIGTERM")
    }
  })
  child.stderr.on("data", (chunk) => (stderr += chunk))
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    return { code, stdout, stderr, interrupted }
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL")
  }
}

describe("self-update protocol", () => {
  const discover = {
    type: "loadout:self-update-discover",
    protocol: 1,
    nonce,
  } as const
  const request = {
    type: "loadout:self-update-request",
    protocol: 1,
    nonce,
    installer: "mise",
    version: targetVersion,
  } as const
  const accepted = {
    type: "loadout:self-update-accepted",
    protocol: 1,
    nonce,
  } as const

  test("accepts only the exact nonce-bound request and response envelopes", () => {
    expect(parseSelfUpdateChildMessage(discover, nonce)).toEqual(discover)
    expect(parseSelfUpdateChildMessage(request, nonce)).toEqual(request)
    expect(parseSelfUpdateParentMessage(accepted, nonce)).toEqual(accepted)
    for (const value of [discover, request, accepted]) {
      const parse =
        value === accepted
          ? parseSelfUpdateParentMessage
          : parseSelfUpdateChildMessage
      for (const invalid of [
        { ...value, nonce: "another-child" },
        { ...value, protocol: 2 },
        { ...value, path: "/tmp/arbitrary-entry.js" },
        { ...value, [Symbol("hidden")]: true },
        Object.assign(Object.create({ inherited: true }), value),
        [value],
        null,
      ])
        expect(parse(invalid, nonce)).toBeUndefined()
      expect(parse(value, "")).toBeUndefined()
      expect(parse(value, "x".repeat(257))).toBeUndefined()
    }
  })

  test("rejects accessor properties without invoking untrusted getters", () => {
    let reads = 0
    for (const field of Object.keys(request)) {
      const value = { ...request }
      Object.defineProperty(value, field, {
        enumerable: true,
        get() {
          reads++
          throw new Error("untrusted getter must not execute")
        },
      })
      expect(parseSelfUpdateChildMessage(value, nonce)).toBeUndefined()
    }
    expect(reads).toBe(0)
  })

  test("rejects command fragments, versions with whitespace and unknown installers", () => {
    for (const version of [
      "latest",
      "v0.6.0",
      "0.6.0; touch /tmp/no",
      "0.6.0\n",
      " 0.6.0",
      "0.6.0 --prefix=/tmp/other",
    ]) {
      expect(
        parseSelfUpdateChildMessage({ ...request, version }, nonce),
      ).toBeUndefined()
      expect(() =>
        formatSelfUpdateCommand({ installer: "npm", version }),
      ).toThrow()
    }
    expect(
      parseSelfUpdateChildMessage({ ...request, installer: "sh" }, nonce),
    ).toBeUndefined()
    expect(
      formatSelfUpdateCommand({ installer: "mise", version: targetVersion }),
    ).toBe("mise use --global 'npm:@lidtop/loadout@0.6.0'")
  })

  test("validates availability lists, optional reasons, and rejection text strictly", () => {
    const availability = {
      type: "loadout:self-update-availability" as const,
      protocol: 1 as const,
      nonce,
      installers: ["mise", "npm"] as UpdateInstaller[],
    }
    expect(parseSelfUpdateParentMessage(availability, nonce)).toEqual(
      availability,
    )
    const parsed = parseSelfUpdateParentMessage(availability, nonce)
    availability.installers.pop()
    expect(parsed && "installers" in parsed && parsed.installers).toEqual([
      "mise",
      "npm",
    ])
    for (const installers of [
      ["npm", "npm"],
      ["sh"],
      Array(1),
      Object.assign(["npm"], { extra: true }),
    ])
      expect(
        parseSelfUpdateParentMessage({ ...availability, installers }, nonce),
      ).toBeUndefined()
    for (const reason of ["", "unsafe\u001b[2J", "x".repeat(513), undefined]) {
      expect(
        parseSelfUpdateParentMessage({ ...availability, reason }, nonce),
      ).toBeUndefined()
      expect(
        parseSelfUpdateParentMessage(
          { ...accepted, type: "loadout:self-update-rejected", reason },
          nonce,
        ),
      ).toBeUndefined()
    }
    const rejected = {
      ...accepted,
      type: "loadout:self-update-rejected",
      reason: "Unavailable for this installation.",
    } as const
    expect(parseSelfUpdateParentMessage(rejected, nonce)).toEqual(rejected)
  })
})

const managerSource = `
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
const c = JSON.parse(readFileSync(process.env.FIXTURE_CONFIG, "utf8"));
const args = process.argv.slice(2);
const manager = process.argv[1].endsWith("npm-cli.js") ? "npm" : "mise";
function log(event, extra = {}) {
  appendFileSync(c.log, JSON.stringify({ event, manager, args, ...extra }) + "\\n");
}
log("manager", { cwd: process.cwd(), environment: process.env });
if (manager === "mise" && existsSync(join(c.home, "mise.local.toml"))) {
  // Model documented discovery boundaries, never interpret project config data.
  if (process.env.MISE_CEILING_PATHS !== c.home) {
    log("unsafe-home-local-discovery");
    process.exit(92);
  }
  log("home-local-excluded");
}
const installing = args[0] === "install" || args[0] === "use";
if (installing) {
  if (c.cancelGrandchild) {
    // The manager deliberately does NOT forward signals. It only waits/reaps.
    // Without process-group cancellation the grandchild writes before exiting.
    const child = spawn(process.execPath, ["-e", \`
      const fs = require("node:fs");
      process.on("SIGTERM", () => {
        fs.appendFileSync(\${JSON.stringify(c.log)}, JSON.stringify({event: "grandchild-terminated"}) + "\\\\n");
        process.exit(0);
      });
      setTimeout(() => {
        fs.writeFileSync(\${JSON.stringify(c.root + "/late-mutation")}, "unsafe post-cancel mutation");
        process.exit(0);
      }, 400);
      process.send("ready");
    \`], {stdio: ["ignore", "ignore", "ignore", "ipc"]});
    let stopping = false;
    process.on("SIGTERM", () => { stopping = true; });
    child.on("message", () => console.log("FIXTURE_MANAGER_READY"));
    child.on("close", () => {
      log("grandchild-closed");
      if (stopping) log("manager-terminated");
      process.exit(0);
    });
  } else if (c.cancelManager) {
    process.on("SIGTERM", () => {
      log("manager-terminated");
      process.exit(0);
    });
    console.log("FIXTURE_MANAGER_READY");
    setInterval(() => {}, 1000);
  } else if (c.managerExit) {
    process.exit(c.managerExit);
  } else {
    const root = manager === "mise" ? c.miseTargetRoot : c.currentRoot;
    const path = join(root, "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.version = c.postVersion || "${targetVersion}";
    writeFileSync(path, JSON.stringify(manifest));
    writeFileSync(join(c.root, "selected-version"), "${targetVersion}");
    log("installed", { root });
  }
} else if (manager === "npm" && args.join(" ") === "root --global") {
  console.log(c.npmModules);
} else if (manager === "mise" && args.join(" ") === "ls --global --json npm:@lidtop/loadout") {
  if (c.poisonMiseAfterFirstQuery) {
    const directory = join(c.home, ".config/mise/conf.d");
    mkdirSync(directory, {recursive: true});
    const target = join(c.cwd, "poisoned.toml");
    writeFileSync(target, "# untrusted fixture configuration");
    symlinkSync(target, join(directory, "poisoned.toml"));
  }
  const version = existsSync(join(c.root, "selected-version")) ? "${targetVersion}" : "${currentVersion}";
  const root = version === "${currentVersion}" ? c.miseCurrentRoot : c.miseTargetRoot;
  console.log(JSON.stringify(c.miseGlobalRecords || [{
    version, installed: true, active: true, install_path: root,
    source: {type: "mise.toml", path: join(c.home, ".config/mise/config.toml")},
    ...c.miseSelection,
  }]));
} else if (manager === "mise" && args[0] === "which") {
  const root = args[3].endsWith("@${currentVersion}") ? c.miseCurrentRoot : c.miseTargetRoot;
  console.log(join(root, "dist", c.miseBin || "launcher.js"));
} else {
  log("unexpected-command");
  process.exit(91);
}
`

// No OS subprocesses are created in this variant. Synthetic group membership
// lets a TERM-resistant descendant outlive manager close without orphan/zombie
// risk. The backend's real cancellation, escalation and polling code still runs.
const backendTransportSource = `
import { EventEmitter } from "node:events";
import { appendFileSync, readFileSync } from "node:fs";
const c = JSON.parse(readFileSync(process.argv[2], "utf8"));
const groups = new Map();
let nextPid = 1000000000;
const log = (event, extra = {}) => appendFileSync(c.log, JSON.stringify({event, ...extra}) + "\\n");
process.kill = (pid, signal) => {
  const child = groups.get(-pid);
  if (!child) throw Object.assign(new Error("synthetic group is gone"), {code: "ESRCH"});
  if (signal === 0) return true;
  log("transport-group-signal", {pid, signal});
  if (signal === "SIGTERM") {
    log("transport-descendant-ignored-term");
    log("transport-manager-exit");
    child.emit("exit", 0, null);
    log("transport-manager-close");
    child.emit("close", 0, null);
  } else if (signal === "SIGKILL") {
    clearInterval(child.keepAlive);
    groups.delete(-pid);
    log("transport-group-gone");
  } else throw new Error("unexpected synthetic group signal");
  return true;
};
export function spawn(file, args, options) {
  const child = new EventEmitter();
  child.pid = nextPid++;
  const interactive = options.stdio === "inherit";
  if (interactive) child.keepAlive = setInterval(() => {}, 1000);
  child.stdout = interactive ? null : new EventEmitter();
  child.stderr = interactive ? null : new EventEmitter();
  groups.set(child.pid, child);
  log("transport-spawn", {file, args, detached: options.detached, interactive});
  setImmediate(() => {
    if (interactive) console.log("FIXTURE_MANAGER_READY");
    else {
      groups.delete(child.pid);
      child.stdout.emit("data", Buffer.from(c.npmModules + "\\n"));
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    }
  });
  return child;
}
`

async function backendFixture(overrides: Record<string, unknown> = {}) {
  const root = await temporary()
  const npmModules = join(root, "global/node_modules")
  const currentRoot = join(npmModules, "@lidtop/loadout")
  const targetRoot = join(root, "mise-target")
  const otherRoot = join(root, "unowned")
  const cwd = join(root, "project")
  const home = join(root, "home")
  const tools = join(root, "tools")
  const npmRoot = join(root, "fake-npm")
  const log = join(root, "events.jsonl")
  await Promise.all([
    installation(currentRoot),
    installation(targetRoot, targetVersion),
    installation(otherRoot),
    mkdir(cwd),
    mkdir(home),
    mkdir(tools),
    mkdir(join(npmRoot, "bin"), { recursive: true }),
  ])
  await writeFile(join(cwd, ".git"), "gitdir: safe-fixture-project\n")
  await mkdir(join(home, ".config/mise"), { recursive: true })
  await writeFile(
    join(home, ".config/mise/config.toml"),
    "# fixture global selection\n",
  )
  const config = {
    root,
    currentRoot,
    targetRoot,
    otherRoot,
    cwd,
    home,
    tools,
    log,
    npmModules,
    miseCurrentRoot: currentRoot,
    miseTargetRoot: targetRoot,
    operation: "perform",
    selection: { installer: "npm", version: targetVersion },
    metadata: {
      name: "@lidtop/loadout",
      version: targetVersion,
      engines: { node: ">=0.1.0" },
      os: [process.platform],
      cpu: [process.arch],
    },
    ...overrides,
  }
  await writeFile(join(npmRoot, "package.json"), '{"name":"npm"}')
  const npm = join(npmRoot, "bin/npm-cli.js")
  await writeFile(npm, `#!${node}\n${managerSource}`)
  await chmod(npm, 0o755)
  await symlink(npm, join(tools, "npm"))
  const mise = join(tools, "mise")
  await writeFile(mise, `#!${node}\n${managerSource}`)
  await chmod(mise, 0o755)
  const configPath = join(root, "config.json")
  const worker = join(root, "worker.ts")
  await writeFile(
    worker,
    `import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { discoverOwnedInstallers, performSelfUpdate, validateSelfUpdateInstallation } from ${JSON.stringify(join(import.meta.dir, "../src/backend/self-update.ts"))};
const c = JSON.parse(readFileSync(process.argv[2], "utf8"));
const log = (event, extra = {}) => appendFileSync(c.log, JSON.stringify({event, ...extra}) + "\\n");
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
globalThis.fetch = async (url, options) => {
  log("fetch", {url: String(url), options: {headers: options.headers, credentials: options.credentials, redirect: options.redirect, hasSignal: options.signal instanceof AbortSignal}});
  if (c.networkError) throw new TypeError("fixture offline");
  if (c.changeDuringFetch) {
    const path = c.currentRoot + "/package.json";
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.version = "0.7.0";
    writeFileSync(path, JSON.stringify(manifest));
  }
  return new Response(c.rawMetadata ?? JSON.stringify(c.metadata), {status: c.status || 200, headers: c.headers});
};
const context = {
  packageRoot: c.currentRoot, version: "${currentVersion}", nodePath: process.execPath,
  cwd: c.cwd, repository: c.repository, home: c.home, signal: controller.signal,
  environment: {
    PATH: c.path || [c.cwd + "/bin", ".", c.tools].join(":"),
    FIXTURE_CONFIG: process.argv[2],
    HOME: c.home, MISE_CEILING_PATHS: c.cwd,
    LOADOUT_SELF_UPDATE_NONCE: "must-not-inherit", NODE_CHANNEL_FD: "999",
    NODE_CHANNEL_SERIALIZATION_MODE: "json", NODE_OPTIONS: "--invalid-option",
    NODE_PATH: c.cwd, BUN_OPTIONS: "untrusted", INIT_CWD: c.cwd,
    MISE_ORIGINAL_CWD: c.cwd, MISE_PROJECT_ROOT: c.cwd, MISE_ENV_FILE: c.cwd + "/.env",
    npm_config_userconfig: c.userconfig || c.cwd + "/.npmrc", MISE_CONFIG_FILE: c.cwd + "/mise.toml",
    npm_config_registry: "https://invalid.example/", "npm_config_@lidtop:registry": "https://invalid.example/",
    ...c.environment,
  }
};
try {
  if (c.preAbort) controller.abort();
  const result = c.operation === "discover" ? await discoverOwnedInstallers(context)
    : c.operation === "validate" ? await validateSelfUpdateInstallation(c.currentRoot, "${currentVersion}")
    : await performSelfUpdate(context, c.selection);
  log("result", {result});
} catch (error) {
  log("failure", {message: error.message});
}
`,
  )
  const build = await Bun.build({
    entrypoints: [worker],
    outdir: root,
    target: "node",
    naming: "worker.mjs",
    plugins: overrides.transport
      ? [
          {
            name: "isolated-backend-process-group",
            setup(build) {
              build.onResolve({ filter: /^node:child_process$/ }, () => ({
                path: "backend-transport",
                namespace: "fixture",
              }))
              build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
                contents: backendTransportSource,
                loader: "js",
              }))
            },
          },
        ]
      : [],
  })
  if (!build.success)
    throw new AggregateError(build.logs, "Backend fixture build")
  const execute = async (changes: Record<string, unknown> = {}) => {
    await writeFile(configPath, JSON.stringify({ ...config, ...changes }))
    const result = await run(join(root, "worker.mjs"), [configPath], {
      cwd,
      interruptOn:
        changes.cancelManager || changes.cancelGrandchild || overrides.transport
          ? "FIXTURE_MANAGER_READY"
          : undefined,
    })
    expect(result.code).toBe(0)
    return { ...result, events: await events(log) }
  }
  return { ...config, execute }
}

function installs(log: Event[]) {
  return log.filter(
    (item) =>
      item.event === "manager" && ["use", "install"].includes(item.args[0]),
  )
}

function failure(log: Event[]) {
  return log.find((item) => item.event === "failure")?.message as
    string | undefined
}

describe("self-update backend with fake managers and release metadata", () => {
  test("npm ownership, exact preflight, sanitized execution and post-install validation", async () => {
    const f = await backendFixture()
    const { events: log } = await f.execute()
    expect(failure(log)).toBeUndefined()
    const commands = log.filter((item) => item.event === "manager")
    expect(commands.map((item) => [item.manager, item.args])).toEqual([
      ["npm", ["root", "--global"]],
      ["npm", ["root", "--global"]],
      [
        "npm",
        [
          "install",
          "--global",
          "@lidtop/loadout@0.6.0",
          "--ignore-scripts",
          "--registry",
          "https://registry.npmjs.org/",
        ],
      ],
      ["npm", ["root", "--global"]],
    ])
    expect(log.find((item) => item.event === "fetch")).toMatchObject({
      url: "https://registry.npmjs.org/@lidtop%2floadout/0.6.0",
      options: { credentials: "omit", redirect: "error", hasSignal: true },
    })
    expect(log.map((item) => item.event)).toEqual([
      "manager",
      "fetch",
      "manager",
      "manager",
      "installed",
      "manager",
      "result",
    ])
    for (const command of commands) {
      expect(command.cwd).toBe(await realpath(f.home))
      expect(command.environment.PATH).toBe(await realpath(f.tools))
      expect(command.environment.PWD).toBe(await realpath(f.home))
      expect(command.environment.NPM_CONFIG_REGISTRY).toBe(
        "https://registry.npmjs.org/",
      )
      expect(command.environment["NPM_CONFIG_@lidtop:registry"]).toBe(
        "https://registry.npmjs.org/",
      )
      for (const key of [
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
        "npm_config_userconfig",
        "MISE_CONFIG_FILE",
        "npm_config_registry",
        "npm_config_@lidtop:registry",
      ])
        expect(command.environment[key]).toBeUndefined()
    }
    expect(log.at(-1)?.result).toEqual({
      packageRoot: await realpath(f.currentRoot),
      version: targetVersion,
      entry: join(await realpath(f.currentRoot), "dist/cli.js"),
    })
  })

  test("Mise queries the exact new version and resolves its fresh cli entry, not the old wrapper", async () => {
    const f = await backendFixture({
      selection: { installer: "mise", version: targetVersion },
    })
    const { events: log } = await f.execute()
    expect(failure(log)).toBeUndefined()
    for (const command of log.filter((item) => item.event === "manager")) {
      expect(command.environment.MISE_CEILING_PATHS).toBe(f.home)
      expect(command.cwd).toBe(f.home)
    }
    expect(
      log
        .filter((item) => item.event === "manager")
        .map((item) => [item.manager, item.args]),
    ).toEqual([
      ["mise", ["ls", "--global", "--json", "npm:@lidtop/loadout"]],
      ["mise", ["which", "loadout", "--tool", "npm:@lidtop/loadout@0.5.1"]],
      ["mise", ["ls", "--global", "--json", "npm:@lidtop/loadout"]],
      ["mise", ["which", "loadout", "--tool", "npm:@lidtop/loadout@0.5.1"]],
      ["mise", ["use", "--global", "npm:@lidtop/loadout@0.6.0"]],
      ["mise", ["ls", "--global", "--json", "npm:@lidtop/loadout"]],
      ["mise", ["which", "loadout", "--tool", "npm:@lidtop/loadout@0.6.0"]],
    ])
    expect(log.at(-1)?.result).toEqual({
      packageRoot: f.targetRoot,
      version: targetVersion,
      entry: join(f.targetRoot, "dist/cli.js"),
    })
  })

  test("discovery inspects ownership only and does not fetch or install", async () => {
    const f = await backendFixture({ operation: "discover" })
    const { events: log } = await f.execute()
    expect(log.at(-1)?.result).toEqual({ installers: ["mise", "npm"] })
    expect(log.filter((item) => item.event === "manager")).toHaveLength(3)
    expect(log.some((item) => item.event === "fetch")).toBe(false)
    expect(installs(log)).toEqual([])
  })

  test("does not fall back to npm when selected Mise does not own the current installation", async () => {
    const f = await backendFixture({
      selection: { installer: "mise", version: targetVersion },
    })
    const { events: log } = await f.execute({ miseCurrentRoot: f.otherRoot })
    expect(failure(log)).toContain("does not own")
    expect(
      log
        .filter((item) => item.event === "manager")
        .map((item) => item.manager),
    ).toEqual(["mise", "mise"])
    expect(log.some((item) => item.event === "fetch")).toBe(false)
    expect(installs(log)).toEqual([])
  })

  test("rejects unowned npm global roots before preflight and never falls back to Mise", async () => {
    const f = await backendFixture()
    const otherModules = join(f.root, "other-global")
    await installation(join(otherModules, "@lidtop/loadout"))
    const { events: log } = await f.execute({ npmModules: otherModules })
    expect(failure(log)).toContain("does not own")
    expect(
      log
        .filter((item) => item.event === "manager")
        .map((item) => item.manager),
    ).toEqual(["npm"])
    expect(log.some((item) => item.event === "fetch")).toBe(false)
    expect(installs(log)).toEqual([])
  })

  for (const [label, miseSelection] of [
    ["inactive installed version", { active: false }],
    ["different globally selected version", { version: "0.4.0" }],
    ["uninstalled global selection", { installed: false }],
  ] as const) {
    test(`Mise installed presence cannot authorize ${label}`, async () => {
      const f = await backendFixture({
        selection: { installer: "mise", version: targetVersion },
      })
      const { events: log } = await f.execute({ miseSelection })
      expect(failure(log)).toContain("globally select")
      expect(
        log.filter((item) => item.event === "manager").map((item) => item.args),
      ).toEqual([["ls", "--global", "--json", "npm:@lidtop/loadout"]])
      expect(installs(log)).toEqual([])
      expect(log.some((item) => item.event === "fetch")).toBe(false)
    })
  }

  test("Mise rejects ambiguous global records even when each resolves to an installed version", async () => {
    const f = await backendFixture({
      selection: { installer: "mise", version: targetVersion },
    })
    const record = {
      version: currentVersion,
      installed: true,
      active: true,
      install_path: f.currentRoot,
      source: {
        type: "mise.toml",
        path: join(f.home, ".config/mise/config.toml"),
      },
    }
    const { events: log } = await f.execute({
      miseGlobalRecords: [record, record],
    })
    expect(failure(log)).toContain("globally select")
    expect(
      log.filter((item) => item.event === "manager").map((item) => item.args),
    ).toEqual([["ls", "--global", "--json", "npm:@lidtop/loadout"]])
    expect(log.some((item) => item.event === "fetch")).toBe(false)
    expect(installs(log)).toEqual([])
  })

  test("Mise rejects a globally reported selection whose source belongs to the project", async () => {
    const f = await backendFixture({
      selection: { installer: "mise", version: targetVersion },
    })
    const source = join(f.cwd, "mise.toml")
    await writeFile(source, "# untrusted source\n")
    const { events: log } = await f.execute({
      miseSelection: { source: { type: "mise.toml", path: source } },
    })
    expect(failure(log)).toContain(
      "global configuration resolves inside the project",
    )
    expect(log.filter((item) => item.event === "manager")).toHaveLength(1)
    expect(log.some((item) => item.event === "fetch")).toBe(false)
    expect(installs(log)).toEqual([])
  })

  test("Mise rejects a physical bin that escapes the globally selected installation prefix", async () => {
    const f = await backendFixture({
      selection: { installer: "mise", version: targetVersion },
    })
    const { events: log } = await f.execute({
      miseSelection: { install_path: f.otherRoot },
    })
    expect(failure(log)).toContain("outside its selected installation")
    expect(log.filter((item) => item.event === "manager")).toHaveLength(2)
    expect(log.some((item) => item.event === "fetch")).toBe(false)
    expect(installs(log)).toEqual([])
  })

  for (const [label, metadata, message] of [
    ["wrong package", { name: "another-package" }, "name or version"],
    ["wrong exact version", { version: "0.6.1" }, "name or version"],
    [
      "unsupported engine syntax",
      { engines: { node: "^26.0.0" } },
      "Node requirement",
    ],
    [
      "unsatisfied engine",
      { engines: { node: ">=999.0.0" } },
      "Node requirement",
    ],
    [
      "excluded operating system",
      { os: [`!${process.platform}`] },
      "operating system or CPU",
    ],
    ["excluded CPU", { cpu: [`!${process.arch}`] }, "operating system or CPU"],
  ] as const) {
    test(`refuses ${label} metadata without invoking install`, async () => {
      const f = await backendFixture()
      const { events: log } = await f.execute({
        metadata: { ...f.metadata, ...metadata },
      })
      expect(failure(log)).toContain(message)
      expect(log.filter((item) => item.event === "fetch")).toHaveLength(1)
      expect(installs(log)).toEqual([])
    })
  }

  for (const [label, overrides] of [
    ["network failure", { networkError: true }],
    ["HTTP failure", { status: 404 }],
    ["malformed JSON", { rawMetadata: "{" }],
    ["oversized declared body", { headers: { "content-length": "131073" } }],
    ["oversized streamed body", { rawMetadata: " ".repeat(131073) }],
  ] as const) {
    test(`fails closed on ${label}`, async () => {
      const f = await backendFixture()
      const { events: log } = await f.execute(overrides)
      expect(failure(log)).toBeDefined()
      expect(installs(log)).toEqual([])
    })
  }

  test("revalidates installation after metadata work instead of implicitly downgrading", async () => {
    const f = await backendFixture({ changeDuringFetch: true })
    const { events: log } = await f.execute()
    expect(failure(log)).toContain("exact version")
    expect(installs(log)).toEqual([])
  })

  test("rejects non-newer selections before any manager or metadata work", async () => {
    const f = await backendFixture({
      selection: { installer: "npm", version: currentVersion },
    })
    const { events: log } = await f.execute()
    expect(failure(log)).toContain("not newer")
    expect(log).toHaveLength(1)
  })

  test("failed installs and wrong post-install versions do not yield restart targets", async () => {
    for (const changes of [{ managerExit: 23 }, { postVersion: "0.6.1" }]) {
      const f = await backendFixture()
      const { events: log } = await f.execute(changes)
      expect(failure(log)).toContain("No restart")
      expect(installs(log)).toHaveLength(1)
      expect(log.some((item) => item.event === "result")).toBe(false)
    }
  })

  test("source checkouts and linked entries never gain manager ownership", async () => {
    for (const kind of ["checkout", "linked-entry"] as const) {
      const f = await backendFixture({ operation: "discover" })
      if (kind === "checkout")
        await writeFile(join(f.currentRoot, ".git"), "gitdir: fixture\n")
      else {
        const entry = join(f.currentRoot, "dist/cli.js")
        await rm(entry)
        await symlink(join(f.targetRoot, "dist/cli.js"), entry)
      }
      const { events: log } = await f.execute()
      expect(log.at(-1)?.result.installers).toEqual([])
      expect(log.at(-1)?.result.reason).toContain("manually")
      expect(log.filter((item) => item.event === "manager")).toEqual([])
    }
  })

  test("cancels before work and while the fake installer runs, awaiting its termination", async () => {
    const before = await backendFixture({ preAbort: true })
    const first = await before.execute()
    expect(failure(first.events)).toContain("cancelled")
    expect(first.events).toHaveLength(1)
    const during = await backendFixture()
    const second = await during.execute({ cancelManager: true })
    expect(second.interrupted).toBe(true)
    expect(failure(second.events)).toContain("cancelled")
    expect(second.events.map((item) => item.event).slice(-2)).toEqual([
      "manager-terminated",
      "failure",
    ])
    expect(second.events.some((item) => item.event === "result")).toBe(false)
  })

  test("nested invocation excludes ancestor repository bins and explicit repository npm configuration", async () => {
    const f = await backendFixture()
    const cwd = join(f.cwd, "packages/app")
    const projectBin = join(f.cwd, "node_modules/.bin")
    await mkdir(cwd, { recursive: true })
    await mkdir(projectBin, { recursive: true })
    const userconfig = join(f.cwd, ".npmrc")
    await writeFile(userconfig, "registry=https://invalid.example/\n")
    for (const manager of ["npm", "mise"]) {
      const path = join(projectBin, manager)
      await writeFile(
        path,
        `#!${node}\nthrow new Error("REPOSITORY_MANAGER_EXECUTED")\n`,
      )
      await chmod(path, 0o755)
    }
    const result = await f.execute({
      cwd,
      path: `${projectBin}:${f.tools}`,
      userconfig,
    })
    expect(failure(result.events)).toBeUndefined()
    expect(result.stderr).not.toContain("REPOSITORY_MANAGER_EXECUTED")
    const commands = result.events.filter((item) => item.event === "manager")
    expect(commands).toHaveLength(4)
    for (const command of commands) {
      expect(command.environment.PATH).toBe(f.tools)
      expect(command.environment.npm_config_userconfig).toBeUndefined()
    }
  })

  test("refuses or safely excludes home mise.local.toml linked into the project", async () => {
    const f = await backendFixture({
      selection: { installer: "mise", version: targetVersion },
    })
    const projectConfig = join(f.cwd, "mise.local.toml")
    await writeFile(projectConfig, "# untrusted project configuration\n")
    await symlink(projectConfig, join(f.home, "mise.local.toml"))
    const { events: log } = await f.execute()
    const commands = log.filter(
      (item) => item.event === "manager" && item.manager === "mise",
    )
    expect(
      log.some((item) => item.event === "unsafe-home-local-discovery"),
    ).toBe(false)
    if (commands.length === 0) {
      expect(failure(log)).toBeDefined()
      expect(log.some((item) => item.event === "fetch")).toBe(false)
      expect(installs(log)).toEqual([])
    } else {
      expect(failure(log)).toBeUndefined()
      expect(commands).toHaveLength(7)
      for (const command of commands) {
        expect(command.environment.MISE_CEILING_PATHS).toBe(f.home)
        expect(command.cwd).toBe(f.home)
      }
      expect(
        log.filter((item) => item.event === "home-local-excluded"),
      ).toHaveLength(commands.length)
      expect(log.at(-1)?.result).toMatchObject({
        packageRoot: f.targetRoot,
        version: targetVersion,
      })
    }
  })

  for (const tree of ["global", "selected-system"] as const) {
    for (const relative of [
      "config.local.toml",
      "config.production.toml",
      ".miserc",
      "conf.d/project.toml",
      "conf.d/project-fragments",
    ]) {
      test(`rejects ${tree} Mise ${relative} linked into the project before any Mise invocation`, async () => {
        const f = await backendFixture({
          selection: { installer: "mise", version: targetVersion },
        })
        const directory =
          tree === "global"
            ? join(f.home, ".config/mise")
            : join(f.root, "selected-system-config")
        const path = join(directory, relative)
        await mkdir(join(path, ".."), { recursive: true })
        const target = relative.endsWith("fragments")
          ? f.cwd
          : join(f.cwd, "project-config.toml")
        if (target !== f.cwd)
          await writeFile(target, "# untrusted project config\n")
        await symlink(target, path)
        const { events: log } = await f.execute({
          environment: {
            MISE_ENV: "production",
            ...(tree === "selected-system"
              ? { MISE_SYSTEM_CONFIG_DIR: directory }
              : {}),
          },
        })
        expect(failure(log)).toContain(
          "configuration resolves inside the project",
        )
        expect(
          log.filter(
            (item) => item.event === "manager" && item.manager === "mise",
          ),
        ).toEqual([])
        expect(log.some((item) => item.event === "fetch")).toBe(false)
        expect(installs(log)).toEqual([])
      })
    }
  }

  test("rechecks global Mise fragments before the next invocation after a successful ownership query", async () => {
    const f = await backendFixture({
      selection: { installer: "mise", version: targetVersion },
    })
    const { events: log } = await f.execute({ poisonMiseAfterFirstQuery: true })
    expect(failure(log)).toContain("configuration resolves inside the project")
    expect(
      log.filter((item) => item.event === "manager").map((item) => item.args),
    ).toEqual([["ls", "--global", "--json", "npm:@lidtop/loadout"]])
    expect(log.some((item) => item.event === "fetch")).toBe(false)
    expect(installs(log)).toEqual([])
  })

  test("explicit repository context excludes its ancestor bins and npm config independently of cwd", async () => {
    const f = await backendFixture()
    const repositoryRoot = join(f.root, "selected-repository")
    const repository = join(repositoryRoot, "packages/app")
    const projectBin = join(repositoryRoot, "node_modules/.bin")
    await mkdir(repository, { recursive: true })
    await mkdir(projectBin, { recursive: true })
    await writeFile(join(repositoryRoot, ".git"), "gitdir: selected-fixture\n")
    const userconfig = join(repositoryRoot, ".npmrc")
    await writeFile(userconfig, "registry=https://invalid.example/\n")
    for (const manager of ["npm", "mise"]) {
      const path = join(projectBin, manager)
      await writeFile(
        path,
        `#!${node}\nthrow new Error("SELECTED_REPOSITORY_MANAGER_EXECUTED")\n`,
      )
      await chmod(path, 0o755)
    }
    const result = await f.execute({
      repository,
      path: `${projectBin}:${f.tools}`,
      userconfig,
    })
    expect(failure(result.events)).toBeUndefined()
    expect(result.stderr).not.toContain("SELECTED_REPOSITORY_MANAGER_EXECUTED")
    const commands = result.events.filter((item) => item.event === "manager")
    expect(commands).toHaveLength(4)
    for (const command of commands) {
      expect(command.environment.PATH).toBe(f.tools)
      expect(command.environment.npm_config_userconfig).toBeUndefined()
      expect(command.cwd).toBe(f.home)
    }
  })

  test("cancels the fake Mise-to-npm process group before its delayed mutation", async () => {
    const f = await backendFixture({
      selection: { installer: "mise", version: targetVersion },
    })
    const result = await f.execute({ cancelGrandchild: true })
    expect(result.interrupted).toBe(true)
    expect(failure(result.events)).toContain("cancelled")
    expect(
      result.events.some((item) => item.event === "grandchild-terminated"),
    ).toBe(true)
    expect(
      result.events.some((item) => item.event === "grandchild-closed"),
    ).toBe(true)
    expect(result.events.at(-1)?.event).toBe("failure")
    expect(await Bun.file(join(f.root, "late-mutation")).exists()).toBe(false)
  })

  test("keeps supervising after manager close and escalates a TERM-resistant descendant group", async () => {
    const f = await backendFixture({ transport: true })
    const result = await f.execute()
    expect(result.interrupted).toBe(true)
    expect(failure(result.events)).toContain("cancelled")
    expect(
      result.events
        .filter((item) => item.event === "transport-group-signal")
        .map((item) => item.signal),
    ).toEqual(["SIGTERM", "SIGKILL"])
    const names = result.events.map((item) => item.event)
    expect(names).toContain("transport-descendant-ignored-term")
    expect(names.indexOf("transport-manager-exit")).toBeLessThan(
      names.indexOf("transport-manager-close"),
    )
    expect(names.indexOf("transport-manager-close")).toBeLessThan(
      names.indexOf("transport-group-gone"),
    )
    expect(names.indexOf("transport-group-gone")).toBeLessThan(
      names.indexOf("failure"),
    )
    expect(names.at(-1)).toBe("failure")
    expect(names).not.toContain("result")
    for (const event of result.events.filter(
      (item) => item.event === "transport-spawn",
    ))
      expect(event.detached).toBe(true)
  })
})

const childSource = `
import { appendFileSync, readFileSync } from "node:fs";
const c = JSON.parse(readFileSync(process.env.FIXTURE_CONFIG, "utf8"));
const log = (event, extra = {}) => appendFileSync(c.log, JSON.stringify({event, ...extra}) + "\\n");
const nonce = process.env.LOADOUT_SELF_UPDATE_NONCE;
log("child-start", {cwd: process.cwd(), args: process.argv.slice(2), nonce, ipc: typeof process.send === "function"});
if (c.mode === "checkout" || c.mode === "idle") process.exit(0);
const request = {type: "loadout:self-update-request", protocol: 1, nonce: c.mode === "wrong-nonce" ? "wrong-child" : nonce, installer: "mise", version: "${targetVersion}"};
if (c.mode === "wrong-nonce" || c.mode === "unaccepted-exit") {
  if (c.mode === "unaccepted-exit") process.exit(42);
  process.send(request, () => process.exit(42));
} else {
  process.on("SIGTERM", () => { log("child-terminated"); process.exit(0); });
  process.on("message", message => {
    log("child-message", {message});
    if (message.type === "loadout:self-update-accepted") {
      log("child-ack");
      if (c.mode === "cancel-child") {
        console.log("FIXTURE_CHILD_READY");
        return;
      }
      log("child-leaving");
      process.exit(c.mode === "normal-quit" ? 0 : 42);
    }
  });
  process.send(request);
}
`

const launcherBackendSource = `
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
const c = JSON.parse(readFileSync(process.env.FIXTURE_CONFIG, "utf8"));
const log = (event, extra = {}) => appendFileSync(c.log, JSON.stringify({event, ...extra}) + "\\n");
export async function validateSelfUpdateInstallation(packageRoot, expectedVersion) {
  log("validate", {packageRoot, expectedVersion});
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (expectedVersion && manifest.version !== expectedVersion) throw new Error("fixture target version mismatch");
  return {packageRoot, version: manifest.version, entry: join(packageRoot, "dist/cli.js")};
}
export async function discoverOwnedInstallers(context) {
  log("discover");
  return {installers: ["mise"]};
}
export async function performSelfUpdate(context, selection) {
  log("perform", {selection, cwd: context.cwd, environmentNonce: context.environment.LOADOUT_SELF_UPDATE_NONCE});
  if (c.mode === "cancel-update") {
    console.log("FIXTURE_UPDATE_READY");
    await new Promise((resolve, reject) => {
      const keepAlive = setInterval(() => {}, 1000);
      context.signal.addEventListener("abort", () => {
        clearInterval(keepAlive);
        log("update-aborted"); reject(new Error("fixture update aborted"));
      }, {once: true});
    });
  }
  if (c.mode === "failed-update") throw new Error("fixture install failed");
  return {packageRoot: c.targetRoot, version: "${targetVersion}", entry: join(c.targetRoot, "dist/cli.js")};
}
`

// Real inherited stdio does not provide a portable controllable exit/close gap.
// This deterministic transport fixture exercises the *real launcher* event
// handlers while separating exit from close and forcing a dropped ACK.
const transportSource = `
import { EventEmitter } from "node:events";
import { readFileSync, appendFileSync } from "node:fs";
const c = JSON.parse(readFileSync(process.env.FIXTURE_CONFIG, "utf8"));
const log = (event, extra = {}) => appendFileSync(c.log, JSON.stringify({event, ...extra}) + "\\n");
export function spawn(file, args, options) {
  const child = new EventEmitter();
  child.connected = true;
  child.kill = () => true;
  child.send = (message, callback) => {
    log("transport-send", {message});
    if (message.type === "loadout:self-update-accepted") {
      log("transport-exit");
      child.emit("exit", c.mode === "lost-ack" ? 0 : 42, null);
      setImmediate(() => {
        log("transport-before-close");
        child.connected = false;
        child.emit("close", c.mode === "lost-ack" ? 0 : 42, null);
      });
      if (c.mode === "lost-ack") throw new Error("fixture IPC channel closed before ACK");
    }
    callback?.();
  };
  setImmediate(() => {
    if (args[1].startsWith(c.targetRoot)) {
      log("transport-restart", {file, args, cwd: options.cwd});
      child.emit("close", 0, null);
    } else {
      child.emit("message", {type: "loadout:self-update-request", protocol: 1, nonce: options.env.LOADOUT_SELF_UPDATE_NONCE, installer: "mise", version: "${targetVersion}"});
    }
  });
  return child;
}
`

async function launcherFixture(mode: string, transport = false) {
  const root = await temporary()
  const currentRoot = join(root, "old-install")
  const targetRoot = join(root, "new-install")
  const cwd = join(root, "original-project")
  const log = join(root, "events.jsonl")
  await Promise.all([
    installation(currentRoot),
    installation(targetRoot, targetVersion),
    mkdir(cwd),
  ])
  if (mode === "checkout")
    await writeFile(join(currentRoot, ".git"), "gitdir: fixture\n")
  await writeFile(join(currentRoot, "dist/cli.js"), childSource)
  await writeFile(
    join(targetRoot, "dist/cli.js"),
    `import { appendFileSync, readFileSync } from "node:fs";
const c = JSON.parse(readFileSync(process.env.FIXTURE_CONFIG, "utf8"));
appendFileSync(c.log, JSON.stringify({event: "new-entry", entry: import.meta.url, cwd: process.cwd(), args: process.argv.slice(2), nonce: process.env.LOADOUT_SELF_UPDATE_NONCE}) + "\\n");
`,
  )
  const config = join(root, "config.json")
  await writeFile(
    config,
    JSON.stringify({ mode, currentRoot, targetRoot, log }),
  )
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/launcher.ts")],
    outdir: join(currentRoot, "dist"),
    target: "node",
    define: { LOADOUT_BUNDLED: "true" },
    plugins: [
      {
        name: "isolated-self-update-fixture",
        setup(build) {
          build.onResolve({ filter: /^\.\/backend\/self-update$/ }, () => ({
            path: "backend",
            namespace: "fixture",
          }))
          if (transport)
            build.onResolve({ filter: /^node:child_process$/ }, () => ({
              path: "transport",
              namespace: "fixture",
            }))
          build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
            contents:
              path === "backend" ? launcherBackendSource : transportSource,
            loader: "js",
          }))
        },
      },
    ],
  })
  if (!build.success)
    throw new AggregateError(build.logs, "Launcher fixture build")
  const args = ["inspect", "--repo", "path with spaces/$not-a-shell", "--json"]
  const result = await run(join(currentRoot, "dist/launcher.js"), args, {
    cwd,
    env: {
      FIXTURE_CONFIG: config,
      [SELF_UPDATE_NONCE_ENV]: "stale-shell-nonce",
    },
    interruptOn:
      mode === "cancel-update"
        ? "FIXTURE_UPDATE_READY"
        : mode === "cancel-child"
          ? "FIXTURE_CHILD_READY"
          : undefined,
  })
  return {
    ...result,
    events: await events(log),
    cwd,
    args,
    currentRoot,
    targetRoot,
  }
}

describe("launcher handoff with isolated fake backend", () => {
  test("ACK + reserved child close updates once and restarts the fresh entry with original cwd/argv", async () => {
    const result = await launcherFixture("update")
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.events.map((item) => item.event)).toEqual([
      "validate",
      "child-start",
      "discover",
      "child-message",
      "child-ack",
      "child-leaving",
      "perform",
      "validate",
      "new-entry",
    ])
    const original = result.events.find((item) => item.event === "child-start")!
    const restarted = result.events.find((item) => item.event === "new-entry")!
    expect(original).toMatchObject({
      cwd: result.cwd,
      args: result.args,
      ipc: true,
    })
    expect(original.nonce).toMatch(/^[a-f0-9]{64}$/)
    expect(restarted).toMatchObject({ cwd: result.cwd, args: result.args })
    expect(restarted.entry).toBe(
      new URL(`file://${join(result.targetRoot, "dist/cli.js")}`).href,
    )
    expect(restarted.nonce).not.toBe(original.nonce)
    expect(
      result.events.find((item) => item.event === "perform"),
    ).toMatchObject({
      selection: { installer: "mise", version: targetVersion },
      cwd: result.cwd,
    })
    expect(
      result.events.find((item) => item.event === "perform")?.environmentNonce,
    ).toBeUndefined()
  })

  test("an ACK followed by normal quit drops the pending update", async () => {
    const result = await launcherFixture("normal-quit")
    expect(result.code).toBe(0)
    expect(result.events.some((item) => item.event === "child-ack")).toBe(true)
    expect(
      result.events.some((item) =>
        ["perform", "new-entry"].includes(item.event),
      ),
    ).toBe(false)
  })

  for (const mode of ["wrong-nonce", "unaccepted-exit"]) {
    test(`${mode} cannot turn reserved exit 42 into an update`, async () => {
      const result = await launcherFixture(mode)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("without an accepted request")
      expect(
        result.events.some((item) =>
          ["discover", "perform", "new-entry"].includes(item.event),
        ),
      ).toBe(false)
    })
  }

  test("checkout launches omit IPC capability and erase stale inherited nonce", async () => {
    const result = await launcherFixture("checkout")
    expect(result.code).toBe(0)
    const child = result.events.find((item) => item.event === "child-start")!
    expect(child.ipc).toBe(false)
    expect(child.nonce).toBeUndefined()
    expect(result.events.map((item) => item.event)).toEqual([
      "validate",
      "child-start",
    ])
  })

  test("ordinary startup does not discover managers or update", async () => {
    const result = await launcherFixture("idle")
    expect(result.code).toBe(0)
    expect(result.events.map((item) => item.event)).toEqual([
      "validate",
      "child-start",
    ])
  })

  test("waits for close rather than exit before invoking updater", async () => {
    const result = await launcherFixture("close-order", true)
    expect(result.code).toBe(0)
    const names = result.events.map((item) => item.event)
    expect(names.indexOf("transport-exit")).toBeLessThan(
      names.indexOf("transport-before-close"),
    )
    expect(names.indexOf("transport-before-close")).toBeLessThan(
      names.indexOf("perform"),
    )
    expect(names.filter((name) => name === "perform")).toHaveLength(1)
    expect(names.at(-1)).toBe("transport-restart")
  })

  test("lost ACK followed by normal close never installs or restarts", async () => {
    const result = await launcherFixture("lost-ack", true)
    expect(result.code).toBe(0)
    expect(result.events.some((item) => item.event === "transport-send")).toBe(
      true,
    )
    expect(
      result.events.some((item) =>
        ["perform", "transport-restart"].includes(item.event),
      ),
    ).toBe(false)
  })

  test("cancellation after ACK closes the child without installing", async () => {
    const result = await launcherFixture("cancel-child")
    expect(result.interrupted).toBe(true)
    expect(result.code).toBe(143)
    expect(
      result.events.some((item) => item.event === "child-terminated"),
    ).toBe(true)
    expect(
      result.events.some((item) =>
        ["perform", "new-entry"].includes(item.event),
      ),
    ).toBe(false)
  })

  test("cancellation during updater aborts it and prevents restart", async () => {
    const result = await launcherFixture("cancel-update")
    expect(result.interrupted).toBe(true)
    expect(result.code).toBe(143)
    expect(result.events.some((item) => item.event === "update-aborted")).toBe(
      true,
    )
    expect(result.events.some((item) => item.event === "new-entry")).toBe(false)
  })

  test("failed updater exits once without restarting the old or new application", async () => {
    const result = await launcherFixture("failed-update")
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("fixture install failed")
    expect(
      result.events.filter((item) => item.event === "child-start"),
    ).toHaveLength(1)
    expect(result.events.some((item) => item.event === "new-entry")).toBe(false)
  })
})
