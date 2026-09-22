import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as yaml } from 'yaml';
import { catalogManifestSchema, parse } from '../dist/schema.js';
import {
  cachePath,
  officialCatalogUrl,
  writeCache,
} from '../dist/subscriptions.js';
import { loadCatalog } from '../dist/catalog.js';
import { blobHash, renderWithExternal } from '../dist/external.js';
import { walk } from '../dist/fs.js';

// Offline fixture for the same manifest and remote-kit pipeline used in production.
export async function seedCatalog() {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const manifest = parse(
    catalogManifestSchema,
    yaml(fs.readFileSync(path.join(project, 'catalog.yaml'), 'utf8'), {
      merge: true,
    }),
    'Official catalog',
  );
  writeCache(cachePath('catalogs', officialCatalogUrl), {
    url: officialCatalogUrl,
    fetchedAt: Date.now(),
    manifest,
  });
  const files = new Map(
    [
      'LICENSE',
      ...walk(path.join(project, 'kits')).map((file) => `kits/${file}`),
    ].map((file) => [file, fs.readFileSync(path.join(project, file))]),
  );
  const fetch = async (url) => {
    if (url.startsWith('https://api.github.com/'))
      return Buffer.from(
        JSON.stringify({
          truncated: false,
          tree: [...files].map(([file, content]) => ({
            path: file,
            type: 'blob',
            mode: '100644',
            size: content.length,
            sha: blobHash(content),
          })),
        }),
      );
    const file = decodeURIComponent(
      new URL(url).pathname.split('/').slice(4).join('/'),
    );
    if (!files.has(file)) throw new Error(`Unexpected fixture request: ${url}`);
    return files.get(file);
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadout-catalog-seed-'));
  try {
    const catalog = loadCatalog(root);
    const selected = [...catalog.kits.values()]
      .filter((kit) => kit.external?.kit)
      .map((kit) => kit.id);
    await renderWithExternal(
      catalog,
      {
        schemaVersion: 1,
        selected,
        answers: Object.fromEntries(
          selected.map((id) => [id, { placement: 'skill' }]),
        ),
      },
      { fetch },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await seedCatalog();
