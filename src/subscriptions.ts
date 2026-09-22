import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse as yaml } from 'yaml';
import { z } from 'zod';
import {
  catalogManifestSchema,
  catalogUrlSchema,
  configSchema,
  parse,
  type CatalogManifest,
  type Subscription,
} from './schema.js';
import { readOptional, safePath } from './fs.js';

export const officialCatalogUrl =
  'https://raw.githubusercontent.com/ZackarySantana/loadout/main/catalog.yaml';
const cacheSchema = z
  .object({
    url: catalogUrlSchema,
    fetchedAt: z.number(),
    manifest: catalogManifestSchema,
  })
  .strict();
export function configSources(
  root: string,
  global = path.resolve(root) === fs.realpathSync(os.homedir()),
) {
  const home = fs.realpathSync(os.homedir());
  return [
    ...(!global && root !== home
      ? [
          {
            root: home,
            directory: '.loadout',
            personal: true,
            scope: 'Personal',
          },
          {
            root: home,
            directory: '.loadout-personal',
            personal: true,
            scope: 'Personal',
          },
        ]
      : []),
    {
      root,
      directory: '.loadout',
      personal: global,
      scope: global ? 'Personal' : 'Repository',
    },
    {
      root,
      directory: '.loadout-personal',
      personal: true,
      scope: global ? 'Personal' : 'Repository private',
    },
  ].map((source) => {
    const file = `${source.directory}/config.yaml`;
    const raw = readOptional(source.root, file);
    return {
      ...source,
      present: !!raw,
      config: parse(
        configSchema,
        raw ? yaml(raw.toString()) : { schemaVersion: 1 },
        `${source.root}/${file}`,
      ),
    };
  });
}
export function subscriptions(root: string, global?: boolean): Subscription[] {
  const configs = configSources(root, global);
  const curated =
    [...configs].reverse().find((source) => source.config.curated !== undefined)
      ?.config.curated ?? true;
  const urls = new Map<string, Set<string>>();
  const add = (value: string, scope: string) => {
    const url = new URL(value).href;
    const scopes = urls.get(url) ?? new Set<string>();
    scopes.add(scope);
    urls.set(url, scopes);
  };
  if (curated) add(officialCatalogUrl, 'Default');
  for (const source of configs)
    for (const url of source.config.catalogs) add(url, source.scope);
  return [...urls].map(([url, scopes]) => ({ url, scopes: [...scopes] }));
}
export function cacheRoot(): string {
  return (
    process.env.LOADOUT_CACHE_DIR ??
    path.join(os.homedir(), '.cache', 'loadout')
  );
}
export function cachePath(kind: string, key: string): string {
  return safePath(
    cacheRoot(),
    `${kind}/${createHash('sha256').update(key).digest('hex')}.json`,
  );
}
export function writeCache(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), {
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
export function readCatalogCache(
  url: string,
): z.infer<typeof cacheSchema> | undefined {
  const file = cachePath('catalogs', url);
  if (!fs.existsSync(file)) return;
  try {
    const cache = parse(
      cacheSchema,
      JSON.parse(fs.readFileSync(file, 'utf8')),
      file,
    );
    return cache.url === url ? cache : undefined;
  } catch {
    // Shared caches are disposable; installed snapshots are validated separately.
    return undefined;
  }
}
export async function refreshCatalogs(
  root: string,
  options: {
    global?: boolean;
    offline?: boolean;
    force?: boolean;
    fetch?: (url: string) => Promise<string>;
    warn?: (message: string) => void;
  } = {},
): Promise<void> {
  const expected = subscriptions(root, options.global);
  const identities = new Map<string, string>();
  for (const { url } of expected) {
    let cached: ReturnType<typeof readCatalogCache>;
    try {
      cached = readCatalogCache(url);
    } catch (error) {
      options.warn?.(
        `Ignoring invalid cache for ${url}: ${(error as Error).message}`,
      );
      if (options.offline) throw error;
    }
    let manifest: CatalogManifest | undefined = cached?.manifest;
    if (
      !options.offline &&
      (options.force ||
        !cached ||
        Date.now() - cached.fetchedAt > 60 * 60 * 1000)
    ) {
      try {
        const text = options.fetch
          ? await options.fetch(url)
          : await fetchManifest(url);
        manifest = parse(
          catalogManifestSchema,
          yaml(text, { merge: true }),
          url,
        );
        if (cached && cached.manifest.id !== manifest.id)
          throw new Error(
            `Catalog identity changed from ${cached.manifest.id} to ${manifest.id}`,
          );
        const other = identities.get(manifest.id);
        if (other && other !== url)
          throw new Error(
            `Catalog ID ${manifest.id} is also published at ${other}`,
          );
        writeCache(cachePath('catalogs', url), {
          url,
          fetchedAt: Date.now(),
          manifest,
        });
      } catch (error) {
        manifest = cached?.manifest;
        options.warn?.(
          `${url}: ${(error as Error).message}${cached ? '; using cached catalog' : '; catalog unavailable'}`,
        );
      }
    } else if (options.offline && !cached) {
      options.warn?.(
        `${url}: no cached catalog; connect once to browse its kits`,
      );
    }
    if (manifest) {
      const other = identities.get(manifest.id);
      if (other && other !== url)
        throw new Error(
          `Catalog ID ${manifest.id} is also published at ${other}`,
        );
      identities.set(manifest.id, url);
    }
  }
}
async function fetchManifest(url: string): Promise<string> {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: { 'User-Agent': 'loadout' },
  });
  if (!response.ok)
    throw new Error(`Catalog request failed (${response.status})`);
  if (!response.body) throw new Error('Empty catalog response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw new Error('Catalog exceeds 2 MiB');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString('utf8');
}
