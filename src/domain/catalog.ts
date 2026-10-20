import { createHash } from "node:crypto"

/** A checkout's canonical root defines identity, not the kit contents. */
export function repositoryCatalogId(repository: string): string {
  return `repo-${createHash("sha256").update(repository).digest("hex")}`
}

export function displayKitKey(key: string): string {
  return key.replace(/^repo-[a-f0-9]{64}\//, "repo/")
}
