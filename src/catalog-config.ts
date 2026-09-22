import fs from 'node:fs';
import { parseDocument } from 'yaml';
import { catalogUrlSchema, configSchema, parse } from './schema.js';
import { readOptional, portableMode, safePath } from './fs.js';
import { apply, loadGenerated, planExcludes } from './storage.js';

export function editSubscription(
  root: string,
  directory: '.loadout' | '.loadout-personal',
  action: 'add' | 'remove',
  ...values: string[]
): boolean {
  const requested = values.map(
    (value) => new URL(parse(catalogUrlSchema, value, 'Catalog URL')).href,
  );
  const file = `${directory}/config.yaml`;
  const before = readOptional(root, file);
  const document = parseDocument(before?.toString() ?? 'schemaVersion: 1\n');
  if (document.errors.length)
    throw new Error(document.errors.map((error) => error.message).join('; '));
  const config = parse(configSchema, document.toJS(), file);
  const urls = config.catalogs.map((entry) => new URL(entry).href);
  const next =
    action === 'add'
      ? [...new Set([...urls, ...requested])]
      : urls.filter((entry) => !requested.includes(entry));
  if (JSON.stringify(next) === JSON.stringify(urls)) return false;
  document.set('catalogs', next);
  const mode = before
    ? portableMode(fs.statSync(safePath(root, file)).mode)
    : 0o644;
  apply({
    root,
    changes: [
      {
        path: file,
        before: before ? { content: before, mode } : undefined,
        after: { content: Buffer.from(document.toString()), mode },
        kind: before ? 'update' : 'create',
      },
    ],
    exclude: planExcludes(root, Object.keys(loadGenerated(root).files)),
  });
  return true;
}
