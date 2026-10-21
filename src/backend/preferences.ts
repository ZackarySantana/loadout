import { mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { z } from "zod"
import {
  assertSafeDirectory,
  sameNode,
  snapshotNode,
  type NodeSnapshot,
} from "./files"

const preferencesSchema = z
  .object({ walkthroughSeen: z.boolean().default(false) })
  .strict()

function preferences(node: NodeSnapshot): z.infer<typeof preferencesSchema> {
  if (node.kind === "missing") return { walkthroughSeen: false }
  if (
    node.kind !== "file" ||
    node.encoding !== undefined ||
    Buffer.byteLength(node.content) > 16_384
  )
    throw new Error("Loadout preferences must be a small regular JSON file")
  return preferencesSchema.parse(JSON.parse(node.content))
}

/** UI preferences are independent of installation intent and reviewed changes. */
export async function readPreferences(home: string) {
  return preferences(
    await snapshotNode(join(home, ".loadout/preferences.json")),
  )
}

/** Only an explicit walkthrough dismissal records that it has been seen. */
export async function dismissWalkthrough(home: string): Promise<void> {
  const path = join(home, ".loadout/preferences.json")
  const before = await snapshotNode(path)
  const current = preferences(before)
  if (current.walkthroughSeen) return
  await assertSafeDirectory(dirname(path))
  await mkdir(dirname(path), { recursive: true })
  await assertSafeDirectory(dirname(path))
  const temporary = `${path}.loadout-${randomUUID()}`
  try {
    await writeFile(
      temporary,
      JSON.stringify({ ...current, walkthroughSeen: true }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    )
    if (!sameNode(before, await snapshotNode(path)))
      throw new Error(
        "Loadout preferences changed; retry closing the walkthrough",
      )
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
