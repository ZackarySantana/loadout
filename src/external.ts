import { createHash } from 'node:crypto';
import path from 'node:path';
import { parse as yaml } from 'yaml';
import { z } from 'zod';
import {
  agents,
  externalSourceSchema,
  idSchema,
  relativePath,
  parse,
  sameSource,
  type Catalog,
  type State,
  type ExternalSource,
} from './schema.js';
import { json, readOptional, portableMode } from './fs.js';
import { resolveKits } from './resolve.js';
import { render, type Rendered } from './render.js';
import { retryDownload } from './retry.js';

const MAX_FILE = 2 * 1024 * 1024;
const MAX_KIT = 8 * 1024 * 1024;
const MAX_FILES = 200;
const snapshotFile = z
  .object({
    data: z.string().max(Math.ceil(MAX_FILE / 3) * 4),
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    mode: z.union([z.literal(420), z.literal(493)]),
  })
  .strict();
const snapshotSchema = z
  .object({
    integrity: z.string().regex(/^[a-f0-9]{64}$/),
    source: externalSourceSchema,
    files: z.record(relativePath, snapshotFile),
  })
  .strict();
const storeSchema = z
  .object({
    schemaVersion: z.literal(1),
    kits: z.record(idSchema, snapshotSchema),
  })
  .strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export type SnapshotCache = Map<string, Snapshot>;
const sourceKey = (source: ExternalSource) =>
  JSON.stringify({
    repo: source.repo,
    ref: source.ref,
    license: source.license,
    skills: [...source.skills].sort(),
  });
export type ExternalStore = z.infer<typeof storeSchema>;
export type FetchBytes = (
  url: string,
  limit: number,
  signal?: AbortSignal,
) => Promise<Buffer>;
export function readExternal(root: string): {
  raw?: Buffer;
  store: ExternalStore;
} {
  const raw = readOptional(root, '.loadout-personal/external.json');
  return {
    raw,
    store: raw
      ? parse(
          storeSchema,
          JSON.parse(raw.toString()),
          '.loadout-personal/external.json',
        )
      : { schemaVersion: 1, kits: {} },
  };
}
function blobHash(content: Buffer): string {
  return createHash('sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');
}
export const fetchBytes: FetchBytes = async (url, limit, signal) => {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'loadout', Accept: 'application/vnd.github+json' },
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      `GitHub request failed (${response.status}): ${url}${response.status === 403 || response.status === 429 ? '. The public API may be rate-limited; try again later.' : ''}`,
    );
  if (!response.body) throw new Error(`Empty response: ${url}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit)
        throw new Error(`Download exceeds ${limit} bytes: ${url}`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
};
const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      type: z.string(),
      mode: z.string(),
      sha: z.string().regex(/^[a-f0-9]{40}$/),
      size: z.number().optional(),
    }),
  ),
});
function skillNames(source: ExternalSource): string[] {
  const names = source.skills.map((p) => path.posix.basename(p));
  if (new Set(names).size !== names.length)
    throw new Error(
      `External kit has duplicate skill names: ${names.join(', ')}`,
    );
  return names;
}
function snapshotIntegrity(
  snapshot: Pick<Snapshot, 'source' | 'files'>,
): string {
  const source = snapshot.source;
  const files = Object.entries(snapshot.files)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, file]) => [name, file.sha, file.mode]);
  return createHash('sha256')
    .update(
      JSON.stringify([
        source.repo,
        source.ref,
        source.skills,
        source.license,
        files,
      ]),
    )
    .digest('hex');
}
function validateSnapshot(snapshot: Snapshot, label: string): void {
  if (snapshot.integrity !== snapshotIntegrity(snapshot))
    throw new Error(`${label}: external snapshot manifest checksum mismatch`);
  const names = skillNames(snapshot.source);
  let size = 0;
  if (Object.keys(snapshot.files).length > MAX_FILES)
    throw new Error(`${label}: too many external files`);
  for (const [file, stored] of Object.entries(snapshot.files)) {
    if (!names.some((name) => file.startsWith(`${name}/`)))
      throw new Error(`${label}: invalid external output ${file}`);
    const data = Buffer.from(stored.data, 'base64');
    size += data.length;
    if (
      data.toString('base64') !== stored.data ||
      blobHash(data) !== stored.sha
    )
      throw new Error(`${label}: external snapshot checksum mismatch: ${file}`);
    if (data.length > MAX_FILE || size > MAX_KIT)
      throw new Error(`${label}: external snapshot exceeds size limit`);
  }
  for (const name of names) {
    const file = snapshot.files[`${name}/SKILL.md`];
    if (!file) throw new Error(`${label}: missing ${name}/SKILL.md`);
    const text = Buffer.from(file.data, 'base64').toString('utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    const meta = frontmatter ? yaml(frontmatter[1]!) : undefined;
    if (
      !meta ||
      meta.name !== name ||
      typeof meta.description !== 'string' ||
      !meta.description.trim()
    )
      throw new Error(
        `${label}: ${name}/SKILL.md needs matching name and description`,
      );
    if (!snapshot.files[`${name}/LICENSE.upstream`])
      throw new Error(`${label}: missing upstream license for ${name}`);
  }
}
async function download(
  source: ExternalSource,
  get: FetchBytes,
): Promise<Snapshot> {
  skillNames(source);
  const tree = parse(
    treeSchema,
    JSON.parse(
      (
        await get(
          `https://api.github.com/repos/${source.repo}/git/trees/${source.ref}?recursive=1`,
          MAX_KIT,
        )
      ).toString(),
    ),
    'GitHub tree',
  );
  if (tree.truncated)
    throw new Error(
      'GitHub returned a truncated tree; this repository is too large for the external kit loader.',
    );
  const chosen: {
    remote: string;
    target: string;
    sha: string;
    mode: number;
    size: number;
  }[] = [];
  const license = tree.tree.find((f) => f.path === source.license);
  if (
    !license ||
    license.type !== 'blob' ||
    !['100644', '100755'].includes(license.mode)
  )
    throw new Error(`Missing regular license file: ${source.license}`);
  for (const skill of source.skills) {
    const name = path.posix.basename(skill);
    for (const entry of tree.tree.filter((f) =>
      f.path.startsWith(`${skill}/`),
    )) {
      if (entry.type === 'tree') continue;
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))
        throw new Error(
          `Unsupported external symlink or submodule: ${entry.path}`,
        );
      const relative = entry.path.slice(skill.length + 1);
      parse(relativePath, relative, `External path ${entry.path}`);
      chosen.push({
        remote: entry.path,
        target: `${name}/${relative}`,
        sha: entry.sha,
        mode: entry.mode === '100755' ? 0o755 : 0o644,
        size: entry.size ?? MAX_FILE + 1,
      });
    }
    chosen.push({
      remote: source.license,
      target: `${name}/LICENSE.upstream`,
      sha: license.sha,
      mode: 0o644,
      size: license.size ?? MAX_FILE + 1,
    });
  }
  if (
    chosen.length > MAX_FILES ||
    chosen.some((f) => f.size > MAX_FILE) ||
    chosen.reduce((sum, f) => sum + f.size, 0) > MAX_KIT
  )
    throw new Error('External kit exceeds file count or size limits.');
  const files: Snapshot['files'] = {};
  for (let start = 0; start < chosen.length; start += 6) {
    const entries = await Promise.all(
      chosen.slice(start, start + 6).map(async (file) => {
        const encoded = file.remote
          .split('/')
          .map(encodeURIComponent)
          .join('/');
        const content = await get(
          `https://raw.githubusercontent.com/${source.repo}/${source.ref}/${encoded}`,
          MAX_FILE,
        );
        if (content.length !== file.size || blobHash(content) !== file.sha)
          throw new Error(`GitHub content checksum mismatch: ${file.remote}`);
        return {
          file,
          stored: {
            data: content.toString('base64'),
            sha: file.sha,
            mode: file.mode as 420 | 493,
          },
        };
      }),
    );
    for (const { file, stored } of entries) {
      if (Object.hasOwn(files, file.target))
        throw new Error(`External output collision: ${file.target}`);
      files[file.target] = stored;
    }
  }
  const snapshot = {
    source,
    files: Object.fromEntries(
      Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  const complete = { ...snapshot, integrity: snapshotIntegrity(snapshot) };
  validateSnapshot(complete, source.repo);
  return complete;
}
export async function renderWithExternal(
  catalog: Catalog,
  state: State,
  options: {
    fetch?: FetchBytes;
    update?: string[];
    offline?: boolean;
    onFetch?: (id: string, source: ExternalSource) => void;
    onRetry?: (id: string) => void;
    retry?: (id: string, error: Error) => Promise<boolean>;
    signal?: AbortSignal;
    cache?: SnapshotCache;
    onReady?: (id: string) => void;
  } = {},
): Promise<Rendered> {
  options.signal?.throwIfAborted();
  const result = render(catalog, state);
  const enabled = resolveKits(catalog, state.selected);
  const { raw, store } = readExternal(catalog.root);
  for (const id of options.update ?? [])
    if (!enabled.includes(id) || !catalog.kits.get(id)?.external)
      throw new Error(`Cannot update ${id}: choose an enabled external kit.`);
  for (const id of enabled) {
    options.signal?.throwIfAborted();
    const kit = catalog.kits.get(id)!;
    const source = kit.external;
    if (!source) {
      options.onReady?.(id);
      continue;
    }
    let snapshot = Object.hasOwn(store.kits, id) ? store.kits[id] : undefined;
    const unchanged = snapshot && sameSource(snapshot.source, source);
    if (
      !snapshot ||
      (options.update?.includes(id) && !(options.offline && unchanged))
    ) {
      const cached = options.cache?.get(sourceKey(source));
      if (!cached && options.offline)
        throw new Error(
          `${id} is not available at the requested revision offline. Run without --offline once to fetch it.`,
        );
      if (!cached) options.onFetch?.(id, source);
      snapshot =
        cached ??
        (await retryDownload(
          async () => {
            const controller = new AbortController();
            const requests = new Map<string, Promise<Buffer>>();
            const get: FetchBytes = (url, limit) => {
              if (!requests.has(url))
                requests.set(
                  url,
                  (options.fetch ?? fetchBytes)(
                    url,
                    limit,
                    options.signal
                      ? AbortSignal.any([options.signal, controller.signal])
                      : controller.signal,
                  ),
                );
              return requests.get(url)!;
            };
            try {
              return await download(source, get);
            } finally {
              controller.abort();
              await Promise.allSettled(requests.values());
              requests.clear();
            }
          },
          options.retry ? (error) => options.retry!(id, error) : undefined,
          () => options.onRetry?.(id),
          options.signal,
        ));
      options.signal?.throwIfAborted();
      validateSnapshot(snapshot, id);
      options.cache?.set(sourceKey(source), snapshot);
      store.kits[id] = snapshot;
    }
    validateSnapshot(snapshot, id);
    for (const agent of agents) {
      const prefix = `${agent === 'codex' ? '.agents' : '.claude'}/skills`;
      for (const name of skillNames(snapshot.source)) {
        const destination = `${prefix}/${name}`;
        if (result.skillRoots.has(destination))
          throw new Error(
            `Output collision: multiple kits target ${destination}`,
          );
        result.skillRoots.add(destination);
      }
      for (const [relative, file] of Object.entries(snapshot.files)) {
        const destination = `${prefix}/${relative}`;
        if (result.files.has(destination))
          throw new Error(`Output collision: ${destination}`);
        result.files.set(destination, {
          content: Buffer.from(file.data, 'base64'),
          mode: portableMode(file.mode),
        });
      }
    }
    options.onReady?.(id);
  }
  if (raw || Object.keys(store.kits).length)
    result.external = {
      before: raw,
      content: json(
        parse(
          storeSchema,
          {
            ...store,
            kits: Object.fromEntries(
              Object.entries(store.kits).sort(([a], [b]) => a.localeCompare(b)),
            ),
          },
          'External snapshots',
        ),
      ),
    };
  result.files = new Map(
    [...result.files].sort(([a], [b]) => a.localeCompare(b)),
  );
  return result;
}
