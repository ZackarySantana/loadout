export type AppUpdateNotice = {
  currentVersion: string
  latestVersion: string
}

type Version = {
  core: [string, string, string]
  prerelease: string[]
}

function parseVersion(value: string): Version | undefined {
  if (value.length > 128) return
  const match =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    )
  // JavaScript's $ also matches before a final newline; require the entire input.
  if (!match || match[0] !== value) return
  const prerelease = match[4]?.split(".") ?? []
  if (prerelease.some((part) => /^[0-9]+$/.test(part) && /^0[0-9]/.test(part)))
    return
  return {
    core: [match[1]!, match[2]!, match[3]!],
    prerelease,
  }
}

/** Strict, bounded SemVer suitable for displaying untrusted registry versions. */
export function isAppVersion(value: unknown): value is string {
  return typeof value === "string" && parseVersion(value) !== undefined
}

function compareNumeric(a: string, b: string): number {
  return a.length !== b.length
    ? Math.sign(a.length - b.length)
    : compareText(a, b)
}

function compareText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1
}

/** SemVer precedence, ignoring build metadata; invalid versions are incomparable. */
export function compareAppVersions(a: string, b: string): number | undefined {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return
  for (let i = 0; i < 3; i++) {
    const compared = compareNumeric(left.core[i]!, right.core[i]!)
    if (compared) return compared
  }
  if (!left.prerelease.length || !right.prerelease.length)
    return left.prerelease.length ? -1 : right.prerelease.length ? 1 : 0
  for (
    let i = 0;
    i < Math.max(left.prerelease.length, right.prerelease.length);
    i++
  ) {
    const l = left.prerelease[i]
    const r = right.prerelease[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const lNumeric = /^[0-9]+$/.test(l)
    const rNumeric = /^[0-9]+$/.test(r)
    const compared =
      lNumeric && rNumeric
        ? compareNumeric(l, r)
        : lNumeric !== rNumeric
          ? lNumeric
            ? -1
            : 1
          : compareText(l, r)
    if (compared) return compared
  }
  return 0
}
