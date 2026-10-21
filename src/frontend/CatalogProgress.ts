import type { CatalogFetchProgress } from "../domain/catalog-progress"

/** Two bounded ASCII lines; counts are checked kits, never bytes or estimates. */
export function catalogProgressText(
  progress: CatalogFetchProgress,
  width: number,
): string {
  const columns = Math.max(0, Math.floor(width))
  const label = {
    cache: "Reading catalog cache",
    checking: "Checking catalog source",
    discovering: "Discovering catalog kits",
    loading: "Preparing catalog kits",
    complete: "Catalog ready",
  }[progress.stage]
  const known =
    Number.isFinite(progress.total) &&
    progress.total! >= 0 &&
    Number.isFinite(progress.completed)
  let line: string
  if (known) {
    const total = Math.floor(progress.total!)
    const completed = Math.max(
      0,
      Math.min(total, Math.floor(progress.completed!)),
    )
    const suffix = ` ${completed}/${total} kits checked`
    const size = Math.max(0, Math.min(28, columns - suffix.length - 2))
    const filled = total > 0 ? Math.floor((size * completed) / total) : 0
    line = size
      ? `[${"=".repeat(filled)}${"-".repeat(size - filled)}]${suffix}`
      : suffix.trim()
  } else {
    const size = Math.max(0, Math.min(28, columns - 2))
    line = size
      ? `[${".".repeat(Math.min(3, size))}${" ".repeat(Math.max(0, size - 3))}]`
      : ""
  }
  return `${label.slice(0, columns)}\n${line.slice(0, columns)}`
}
