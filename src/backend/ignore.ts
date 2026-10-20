import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import type { IgnoreMode } from "../domain/settings"
import type { State } from "./state"
import { assertSafeDirectory, assertSafePath } from "./files"
import { inside } from "./settings"

const execute = promisify(execFile)
export interface GitContext {
  repository: string
  top: string
  exclude: string
  gitDirectory: string
  commonDirectory: string
  sharedExclude: boolean
}
export interface IgnoreTarget {
  path: string
  mode: "shared" | "local"
  repositories: string[]
  patterns: string[]
  shared?: boolean
}
export interface IgnoreReport {
  mode: IgnoreMode
  targets: IgnoreTarget[]
  removedTargets: IgnoreTarget[]
  tracked: { repository: string; path: string }[]
  warnings: string[]
}
export interface IgnorePlan {
  managed: State["managed"]
  report: IgnoreReport
  contexts: GitContext[]
}

function safeText(value: string): void {
  if (!value || /[\x00-\x1f\x7f]/.test(value))
    throw new Error(
      "Ignore paths must be nonempty and contain no control characters",
    )
}

async function git(repository: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  )
  const result = await execute(
    "git",
    ["--literal-pathspecs", "-C", repository, ...args],
    {
      env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  )
  return result.stdout
}

export async function gitContext(repository: string): Promise<GitContext> {
  safeText(repository)
  await assertSafeDirectory(repository)
  try {
    const line = (text: string) =>
      text.endsWith("\n") ? text.slice(0, -1) : text
    const top = line(await git(repository, ["rev-parse", "--show-toplevel"]))
    const exclude = line(
      await git(repository, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "info/exclude",
      ]),
    )
    const gitDirectory = line(
      await git(repository, [
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
      ]),
    )
    const commonDirectory = line(
      await git(repository, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    )
    const worktrees = await git(repository, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ])
    safeText(top)
    safeText(exclude)
    safeText(gitDirectory)
    safeText(commonDirectory)
    if (
      !isAbsolute(top) ||
      !isAbsolute(exclude) ||
      !isAbsolute(gitDirectory) ||
      !isAbsolute(commonDirectory) ||
      (repository !== top && !inside(top, repository))
    )
      throw new Error("Unexpected Git worktree paths")
    await assertSafeDirectory(top)
    await assertSafePath(exclude)
    return {
      repository,
      top,
      exclude,
      gitDirectory,
      commonDirectory,
      sharedExclude:
        gitDirectory !== commonDirectory ||
        worktrees.split("\0").filter((entry) => entry.startsWith("worktree "))
          .length > 1,
    }
  } catch {
    throw new Error(
      `Ignore settings require an accessible Git worktree and safe exclude file: ${repository}`,
    )
  }
}

/** Exact file rules, anchored at the ignore file's Git interpretation root. */
export function ignorePattern(base: string, path: string): string {
  safeText(path)
  if (!inside(base, path))
    throw new Error(`Cannot ignore a file outside its repository: ${path}`)
  const name = relative(base, path).split(sep).join("/")
  return "/" + name.replace(/[\\#!*?\[\] ]/g, "\\$&")
}

export async function authorizeIgnoreTargets(
  states: State[],
): Promise<Set<string>> {
  const allowed = new Set<string>()
  const contexts = new Map<string, Promise<GitContext>>()
  for (const state of states)
    for (const [path, managed] of Object.entries(state.managed)) {
      if (managed.type !== "ignore") continue
      safeText(path)
      if (
        !isAbsolute(path) ||
        path.split("/").includes(".loadout") ||
        (managed.mode === "shared" && path.split("/").includes(".git"))
      )
        throw new Error(`Invalid managed ignore target: ${path}`)
      for (const repository of managed.repositories) {
        if (!Object.hasOwn(state.repositories, repository))
          throw new Error(
            `Ignore target is not associated with a known repository: ${path}`,
          )
        let expected = join(repository, ".gitignore")
        if (managed.mode === "local") {
          let pending = contexts.get(repository)
          if (!pending) {
            pending = gitContext(repository)
            contexts.set(repository, pending)
          }
          expected = (await pending).exclude
        }
        if (path !== expected)
          throw new Error(
            `Managed ignore target no longer matches Git metadata; review its repository: ${path}`,
          )
      }
      allowed.add(path)
    }
  return allowed
}

export async function planIgnores(
  mode: IgnoreMode,
  artifacts: Map<string, Set<string>>,
  currentRepository: string,
  previous: State,
): Promise<IgnorePlan> {
  const report: IgnoreReport = {
    mode,
    targets: [],
    removedTargets: [],
    tracked: [],
    warnings: [],
  }
  const managed: State["managed"] = {}
  const contexts = new Map<string, GitContext>()
  const context = async (repository: string) => {
    let value = contexts.get(repository)
    if (!value) {
      value = await gitContext(repository)
      contexts.set(repository, value)
    }
    return value
  }
  // Local cleanup must still prove the exact Git-resolved target.
  for (const [path, old] of Object.entries(previous.managed))
    if (old.type === "ignore") {
      if (old.mode === "local")
        for (const repository of old.repositories) {
          if ((await context(repository)).exclude !== path)
            throw new Error(
              `Git exclude target changed; cannot safely clean up: ${path}`,
            )
        }
    }
  if (mode !== "none") {
    for (const repository of [
      ...new Set([currentRepository, ...artifacts.keys()]),
    ].sort()) {
      const info = await context(repository)
      const paths = [...(artifacts.get(repository) ?? [])].sort()
      const target =
        mode === "shared" ? join(repository, ".gitignore") : info.exclude
      await assertSafePath(target)
      for (const path of paths) {
        safeText(path)
        if (!inside(repository, path))
          throw new Error(`Repository output is outside its scope: ${path}`)
        if (path === target)
          throw new Error(
            `An output cannot manage the ignore file itself: ${path}`,
          )
      }
      const tracked = new Set<string>()
      for (let offset = 0; offset < paths.length; offset += 128) {
        const chunk = paths.slice(offset, offset + 128)
        const output = await git(repository, [
          "ls-files",
          "--cached",
          "--full-name",
          "-z",
          "--",
          ...chunk.map((path) => relative(repository, path)),
        ])
        for (const name of output.split("\0").filter(Boolean)) {
          safeText(name)
          tracked.add(resolve(info.top, name))
        }
      }
      const patterns: string[] = []
      for (const path of paths) {
        if (tracked.has(path)) {
          report.tracked.push({ repository, path })
          continue
        }
        patterns.push(
          ignorePattern(mode === "shared" ? repository : info.top, path),
        )
      }
      if (patterns.length) {
        let entry = report.targets.find((entry) => entry.path === target)
        if (!entry) {
          entry = { path: target, mode, repositories: [], patterns: [] }
          report.targets.push(entry)
        }
        entry.repositories.push(repository)
        entry.patterns.push(...patterns)
      }
    }
  }
  for (const target of report.targets) {
    target.patterns = [...new Set(target.patterns)].sort()
    target.repositories.sort()
    managed[target.path] = {
      type: "ignore",
      mode: target.mode,
      patterns: target.patterns,
      repositories: target.repositories,
    }
  }
  for (const [path, old] of Object.entries(previous.managed))
    if (old.type === "ignore" && !managed[path])
      report.removedTargets.push({
        path,
        mode: old.mode,
        patterns: [...old.patterns],
        repositories: [...old.repositories],
      })
  for (const target of [...report.targets, ...report.removedTargets])
    if (target.mode === "local")
      target.shared =
        target.repositories.length > 1 ||
        target.repositories.some(
          (repository) => contexts.get(repository)?.sharedExclude,
        )
  if (
    (mode === "local" &&
      [...contexts.values()].some((context) => context.sharedExclude)) ||
    [...report.targets, ...report.removedTargets].some(
      (target) => target.shared,
    )
  )
    report.warnings.push(
      "Private Git exclude rules are shared with linked worktrees and can affect the same relative paths there. Known rules for this exclude file are combined.",
    )
  if (report.tracked.length)
    report.warnings.push(
      "Already-tracked managed outputs are not ignored. No files will be untracked or have index flags changed.",
    )
  report.targets.sort((a, b) => a.path.localeCompare(b.path))
  report.removedTargets.sort((a, b) => a.path.localeCompare(b.path))
  return {
    managed,
    report,
    contexts: [...contexts.values()].sort((a, b) =>
      a.repository.localeCompare(b.repository),
    ),
  }
}
