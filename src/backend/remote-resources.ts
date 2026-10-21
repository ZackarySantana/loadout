import type { Catalog } from "../domain/kit"
import type { RemoteSkillsSource } from "../domain/catalog-source"
import {
  resourceBytes,
  resourceFromBytes,
  type Resource,
} from "../domain/resource"

/** These formats remain opaque even when an individual file happens to be UTF-8.
 * This changes representation/preview only: every byte is still copied and hashed.
 */
export function rawAssetPath(path: string): boolean {
  return /\.(?:ttf|otf|woff2?|eot|pdf|png|jpe?g|gif|webp|ico|bmp|tiff?|avif|heic|zip|tar|gz|tgz|bz2|xz|7z|rar|mp[34]|wav|ogg|flac|mov|webm|docx|xlsx|pptx)$/i.test(
    path,
  )
}

export function assetResource(bytes: Uint8Array, path: string): Resource {
  return rawAssetPath(path)
    ? { encoding: "base64", content: Buffer.from(bytes).toString("base64") }
    : resourceFromBytes(bytes)
}

export function mandatoryResource(path: string): boolean {
  const name = path.split("/").at(-1)!
  return (
    name === "SKILL.md" ||
    /^(?:licen[cs]e|notice|copying|copyright|ofl|unlicense)(?:[._-].*)?$/i.test(
      name,
    )
  )
}

/** Only the obsolete ancillary text-decoding failure is hidden. Required metadata,
 * legal notices, declared licenses, integrity failures, and size errors stay visible.
 */
export function legacyResourceFailure(
  record: { descriptor: RemoteSkillsSource },
  reason: string,
): boolean {
  const licenses = new Set(
    [
      record.descriptor.license,
      ...(record.descriptor.kits ?? []).flatMap((kit) =>
        kit.skills.map((skill) => skill.license),
      ),
    ].filter((path) => path !== undefined),
  )
  const match =
    /^Cannot adapt upstream resource (.*): expected UTF-8 text;/.exec(reason)
  return !!(match && !mandatoryResource(match[1]!) && !licenses.has(match[1]!))
}

export function needsResourceRebuild(record: {
  catalog: Catalog
  descriptor: RemoteSkillsSource
}): boolean {
  return !!record.catalog.unavailableKits?.some((item) =>
    legacyResourceFailure(record, item.reason),
  )
}

/** Presentation-only partial inventory preserves original age and consent. Raw
 * cache records and installed snapshots are never rewritten by this view.
 */
export function resourceCachedView(
  catalog: Catalog,
  descriptor: RemoteSkillsSource,
): Catalog {
  const rebuild = needsResourceRebuild({ catalog, descriptor })
  const removed = new Set(
    (catalog.unavailableKits ?? [])
      .filter((item) => legacyResourceFailure({ descriptor }, item.reason))
      .map((item) => `${item.key}: ${item.reason}`),
  )
  return {
    ...catalog,
    ...(rebuild ? { hydration: "partial" as const } : {}),
    kits: catalog.kits.map((item) => ({
      ...item,
      kit: {
        ...item.kit,
        outputs: item.kit.outputs.map((output) => {
          if (output.type !== "skill") return output
          const root = item.origin?.remote?.skillPaths?.find(
            (path) =>
              (path === "."
                ? descriptor.repo.split("/")[1]
                : path.split("/").at(-1)) === output.name,
          )
          const explicitLicense = descriptor.kits
            ?.find((choice) => choice.id === item.kit.id)
            ?.skills.find((skill) => skill.path === root)?.license
          const hasOwnLicense = Object.keys(output.files).some((path) =>
            /^licen[cs]e(?:\.[^/]*)?$/i.test(path),
          )
          const license =
            explicitLicense ?? (hasOwnLicense ? undefined : descriptor.license)
          return {
            ...output,
            files: Object.fromEntries(
              Object.entries(output.files).map(([path, resource]) => [
                path,
                typeof resource === "string" &&
                !mandatoryResource(path) &&
                (root === "." ? path : `${root}/${path}`) !== license
                  ? assetResource(resourceBytes(resource), path)
                  : resource,
              ]),
            ),
          }
        }),
      },
    })),
    unavailableKits: catalog.unavailableKits?.filter(
      (item) => !legacyResourceFailure({ descriptor }, item.reason),
    ),
    issues: catalog.issues?.filter((issue) => !removed.has(issue)),
  }
}
