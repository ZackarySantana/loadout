import { isAbsolute, relative, sep } from "node:path"
import type { Catalog } from "../domain/kit"

function within(source: string, directory: string): string | undefined {
  if (!isAbsolute(source) || !isAbsolute(directory)) return
  const path = relative(directory, source)
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return
  return path.replaceAll(sep, "/")
}

/** Presentation only: never substitutes for a catalog's source identity. */
export function catalogSourceLabel(
  catalog: Catalog,
  repository?: string,
  home?: string,
): string {
  if (catalog.kind === "builtin") return "Built into Loadout."
  if (catalog.kind === "remote") {
    if (!catalog.upstream) return "Remote catalog"
    const { repo, ref, directory } = catalog.upstream
    return [
      `https://github.com/${repo}`,
      ...(directory ? [directory] : []),
      ...(ref ? [`ref: ${ref}`] : []),
    ].join(" · ")
  }
  if (/^https?:\/\//i.test(catalog.source)) return catalog.source
  const projectPath = repository
    ? within(catalog.source, repository)
    : undefined
  if (projectPath !== undefined) return projectPath ? `./${projectPath}` : "."
  const homePath = home ? within(catalog.source, home) : undefined
  if (homePath !== undefined) return homePath ? `~/${homePath}` : "~"
  return catalog.source
}
