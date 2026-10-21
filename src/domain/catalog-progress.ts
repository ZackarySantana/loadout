/** Counts describe prepared kits, including unavailable kits, never transferred bytes. */
export interface CatalogFetchProgress {
  source: string
  stage: "cache" | "checking" | "discovering" | "loading" | "complete"
  completed?: number
  total?: number
}
