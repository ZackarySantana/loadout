import { createHash } from "node:crypto"
import { z } from "zod"

/** Require padded, canonical RFC 4648 base64, including canonical pad bits. */
export const base64ContentSchema = z
  .string()
  .refine(
    (content) =>
      content.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(content) &&
      Buffer.from(content, "base64").toString("base64") === content,
    "Use canonical base64",
  )

export const binaryResourceSchema = z
  .object({ encoding: z.literal("base64"), content: base64ContentSchema })
  .strict()
export const resourceSchema = z.union([z.string(), binaryResourceSchema])
export type Resource = z.infer<typeof resourceSchema>

/** State and journal files retain their legacy string content field. */
export interface EncodedContent {
  content: string
  encoding?: "base64"
}

export function validEncodedContent(value: EncodedContent): boolean {
  return (
    value.encoding === undefined ||
    base64ContentSchema.safeParse(value.content).success
  )
}

export function resourceBytes(resource: Resource): Buffer {
  return typeof resource === "string"
    ? Buffer.from(resource, "utf8")
    : Buffer.from(resource.content, "base64")
}

export function resourceFromBytes(bytes: Uint8Array): Resource {
  const buffer = Buffer.from(bytes)
  if (hasBinarySignature(buffer))
    return { encoding: "base64", content: buffer.toString("base64") }
  const text = buffer.toString("utf8")
  // Buffer's UTF-8 decoder preserves BOMs. A round trip rejects replacement decoding.
  return buffer.equals(Buffer.from(text, "utf8")) &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)
    ? text
    : { encoding: "base64", content: buffer.toString("base64") }
}

export function resourceSize(resource: Resource): number {
  if (typeof resource === "string") return Buffer.byteLength(resource, "utf8")
  const content = resource.content
  return (
    (content.length / 4) * 3 -
    (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0)
  )
}

/** Signature checks only: never parse, extract, or interpret raw asset formats. */
function hasBinarySignature(bytes: Buffer): boolean {
  return (
    ["%PDF-", "GIF87a", "GIF89a", "wOFF", "wOF2", "OTTO", "ttcf"].some(
      (magic) => bytes.subarray(0, magic.length).equals(Buffer.from(magic)),
    ) ||
    bytes.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0])) ||
    bytes.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])) ||
    [
      [0x50, 0x4b, 0x03, 0x04],
      [0x50, 0x4b, 0x05, 0x06],
      [0x50, 0x4b, 0x07, 0x08],
    ].some((magic) => bytes.subarray(0, 4).equals(Buffer.from(magic))) ||
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
    bytes.subarray(257, 262).equals(Buffer.from("ustar"))
  )
}

export function encodedResource(value: EncodedContent): Resource {
  return value.encoding === "base64"
    ? { encoding: "base64", content: value.content }
    : value.content
}

export function encodedBytes(value: EncodedContent): Buffer {
  return resourceBytes(encodedResource(value))
}

export function resourceContent(resource: Resource): EncodedContent {
  return typeof resource === "string" ? { content: resource } : { ...resource }
}

/** Never expose binary payloads in human-facing file previews. */
export function resourcePreview(resource: Resource): string {
  if (typeof resource === "string") return resource
  const bytes = resourceBytes(resource)
  return `[Binary file: ${bytes.length} bytes; SHA-256 ${createHash("sha256").update(bytes).digest("hex")}]`
}
