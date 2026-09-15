import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  exists,
  json,
  readOptional,
  safePath,
  walk,
  portableMode,
} from './fs.js';
import { isOutput } from './output-path.js';
import { parse } from './schema.js';
import type { FileContent, Rendered } from './render.js';
import type { Change } from './storage.js';

const manifestPath = '.loadout/adopted.json';
const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    files: z.record(
      z.string(),
      z
        .object({
          hash: z.string().regex(/^[a-f0-9]{64}$/),
          mode: z.number().int().min(0).max(0o777),
        })
        .strict(),
    ),
  })
  .strict();

function read(root: string, file: string): FileContent | undefined {
  const content = readOptional(root, file);
  return content === undefined
    ? undefined
    : {
        content,
        mode: portableMode(fs.statSync(safePath(root, file)).mode),
      };
}

function compose(original: Buffer, generated: Buffer, file: string): Buffer {
  const base = original.toString('utf8');
  if (!Buffer.from(base).equals(original) || original.includes(0))
    throw new Error(`Cannot preserve ${file}: expected UTF-8 instructions.`);
  if (path.posix.basename(file) === 'CLAUDE.md') {
    const normalize = (line: string) => line.trim().replace(/^@\.\//, '@');
    if (
      base
        .split(/\r?\n/)
        .some((line) => normalize(line) === normalize(generated.toString()))
    )
      return original;
  }
  const crlf = (base.match(/\r\n/g) ?? []).length;
  const newline =
    crlf > (base.match(/(?<!\r)\n/g) ?? []).length ? '\r\n' : '\n';
  return Buffer.concat([
    original,
    Buffer.from(
      base ? (base.endsWith('\n') ? newline : newline + newline) : '',
    ),
    Buffer.from(generated.toString('utf8').replace(/\r?\n/g, newline)),
  ]);
}

// This only prepares bytes. Baselines, outputs, and ownership are committed by
// the same preview/recheck/rollback transaction as every other Loadout file.
export function prepareAdoption(
  root: string,
  rendered: Rendered,
  owned: Record<string, { hash: string; mode: number }>,
  global: boolean,
  allow: boolean,
): {
  files: Map<string, FileContent>;
  originals: Map<string, FileContent>;
  released: Set<string>;
  adopted: string[];
  beforeOutputs: Change[];
  afterOutputs: Change[];
} {
  const beforeManifest = read(root, manifestPath);
  const manifest = beforeManifest
    ? parse(
        manifestSchema,
        JSON.parse(beforeManifest.content.toString()),
        manifestPath,
      )
    : {
        schemaVersion: 1 as const,
        files: {} as z.infer<typeof manifestSchema>['files'],
      };
  const originals = new Map<string, FileContent>();
  const blobs = new Map<string, FileContent>();
  for (const [file, entry] of Object.entries(manifest.files)) {
    if (!isOutput(file, global) || !Object.hasOwn(owned, file))
      throw new Error(`Unexpected adopted output: ${file}`);
    const blobPath = `.loadout/adopted/${entry.hash}`;
    const blob = read(root, blobPath);
    if (!blob || digest(blob.content) !== entry.hash)
      throw new Error(
        `Original content is missing or changed for ${file}. Restore its .loadout/adopted backup before applying.`,
      );
    blobs.set(blobPath, blob);
    originals.set(file, { content: blob.content, mode: entry.mode });
  }
  const adopted: string[] = [];
  if (allow) {
    for (const skill of rendered.skillRoots) {
      if (
        !exists(safePath(root, skill)) ||
        Object.keys(owned).some((file) => file.startsWith(`${skill}/`))
      )
        continue;
      const actual = walk(safePath(root, skill))
        .map((file) => `${skill}/${file}`)
        .sort();
      const expected = [...rendered.files.keys()]
        .filter((file) => file.startsWith(`${skill}/`))
        .sort();
      if (
        JSON.stringify(actual) !== JSON.stringify(expected) ||
        actual.some((file) => {
          const current = read(root, file)!;
          const next = rendered.files.get(file)!;
          return (
            !current.content.equals(next.content) || current.mode !== next.mode
          );
        })
      )
        throw new Error(
          `Existing skill differs: ${skill}. Rename or move that folder, or deselect the kit, before continuing.`,
        );
    }
    for (const file of rendered.files.keys()) {
      if (Object.hasOwn(owned, file)) continue;
      const original = read(root, file);
      if (original) {
        const expected = rendered.files.get(file)!;
        if (
          [...rendered.skillRoots].some((skill) =>
            file.startsWith(`${skill}/`),
          ) &&
          (!original.content.equals(expected.content) ||
            original.mode !== expected.mode)
        )
          throw new Error(
            `Existing skill differs: ${file}. Rename or move its folder, or deselect the kit, before continuing.`,
          );
        originals.set(file, original);
        adopted.push(file);
      }
    }
  }
  const files = new Map(rendered.files);
  const released = new Set<string>();
  const nextManifest: z.infer<typeof manifestSchema> = {
    schemaVersion: 1,
    files: {},
  };
  const nextBlobs = new Map<string, FileContent>();
  for (const [file, original] of originals) {
    const next = files.get(file);
    if (!next) {
      files.set(file, original);
      released.add(file);
      continue;
    }
    if (
      ['AGENTS.md', 'CLAUDE.md'].includes(path.posix.basename(file)) &&
      !/^\.(agents|claude)\/skills\//.test(file)
    )
      files.set(file, {
        ...next,
        content: compose(original.content, next.content, file),
      });
    const hash = digest(original.content);
    nextManifest.files[file] = { hash, mode: original.mode };
    const blobPath = `.loadout/adopted/${hash}`;
    const existing = blobs.get(blobPath) ?? read(root, blobPath);
    if (existing && !existing.content.equals(original.content))
      throw new Error(`Original backup changed: ${blobPath}`);
    nextBlobs.set(
      blobPath,
      existing ?? { content: original.content, mode: portableMode(0o600) },
    );
  }
  const beforeOutputs: Change[] = [];
  const afterOutputs: Change[] = [];
  for (const [file, after] of nextBlobs) {
    const before = blobs.get(file) ?? read(root, file);
    beforeOutputs.push({
      path: file,
      before,
      after,
      kind: before ? 'unchanged' : 'create',
    });
  }
  for (const [file, before] of blobs)
    if (!nextBlobs.has(file))
      afterOutputs.push({ path: file, before, kind: 'delete' });
  if (beforeManifest || Object.keys(nextManifest.files).length) {
    const after = Object.keys(nextManifest.files).length
      ? {
          content: json(nextManifest),
          mode: beforeManifest?.mode ?? portableMode(0o600),
        }
      : undefined;
    afterOutputs.push({
      path: manifestPath,
      before: beforeManifest,
      after,
      kind: !after
        ? 'delete'
        : !beforeManifest
          ? 'create'
          : after.content.equals(beforeManifest.content)
            ? 'unchanged'
            : 'update',
    });
  }
  return { files, originals, released, adopted, beforeOutputs, afterOutputs };
}
