import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as yaml } from 'yaml';
import {
  kitSchema,
  parse,
  validAnswer,
  idSchema,
  type Catalog,
  type Kit,
  type ExternalKit,
} from './schema.js';
import { exists, safePath, walk, readOptional } from './fs.js';
import { resolveKits } from './resolve.js';
import {
  configSources,
  subscriptions,
  readCatalogCache,
} from './subscriptions.js';
import {
  readExternal,
  readSharedSnapshot,
  snapshotResources,
  kitIntegrity,
} from './external.js';

export function discover(cwd: string): string {
  let root = fs.realpathSync(cwd);
  const initial = root;
  const home = fs.realpathSync(os.homedir());
  while (true) {
    // A home catalog is global, never an implicit catalog for child projects.
    if (root === home && root !== initial) break;
    if (
      exists(path.join(root, '.loadout/config.yaml')) ||
      exists(path.join(root, '.loadout-personal'))
    )
      return root;
    if (exists(path.join(root, '.git'))) return root;
    if (path.dirname(root) === root) break;
    root = path.dirname(root);
  }
  return initial;
}
function readYaml(root: string, relative: string): unknown {
  try {
    return yaml(fs.readFileSync(safePath(root, relative), 'utf8'));
  } catch (error) {
    throw new Error(`${relative}: ${(error as Error).message}`);
  }
}
function validateKit(kit: Kit): void {
  if (kit.ready === false) return;
  const dir = kit.directory;
  for (const [key, q] of Object.entries(kit.questions)) {
    if (q.default !== undefined && !validAnswer(q, q.default))
      throw new Error(`${kit.id}.${key}: invalid default`);
    if (q.type === 'choice' && new Set(q.choices).size !== q.choices.length)
      throw new Error(`${kit.id}.${key}: duplicate choices`);
  }
  for (const output of kit.outputs) {
    const source = safePath(dir, output.source);
    if (!exists(source))
      throw new Error(`${kit.id}: missing source ${output.source}`);
    if (output.when) {
      const q = kit.questions[output.when.answer];
      if (!q || !validAnswer(q, output.when.equals))
        throw new Error(
          `${kit.id}: invalid condition on ${output.when.answer}`,
        );
    }
    if (output.type === 'instructions') {
      if (!fs.statSync(source).isFile())
        throw new Error(`${kit.id}: instructions source must be a file`);
    } else {
      if (!fs.statSync(source).isDirectory())
        throw new Error(`${kit.id}: skill source must be a directory`);
      const name = path.basename(source);
      parse(idSchema, name, `${kit.id}: skill directory name`);
      const files = walk(source);
      if (!files.includes('SKILL.md'))
        throw new Error(`${kit.id}: skill requires SKILL.md`);
      const skill = fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8');
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill);
      if (!frontmatter)
        throw new Error(`${kit.id}: SKILL.md needs YAML frontmatter`);
      const meta = yaml(frontmatter[1]!);
      if (
        !meta ||
        meta.name !== name ||
        typeof meta.description !== 'string' ||
        !meta.description.trim()
      )
        throw new Error(
          `${kit.id}: SKILL.md needs name: ${name} and a description`,
        );
    }
  }
}
export function loadCatalog(
  root: string,
  global = path.resolve(root) === fs.realpathSync(os.homedir()),
): Catalog {
  const configs = configSources(root, global);
  const externalKits = configs.flatMap(({ config }) => config.externalKits);
  const kits: Catalog['kits'] = new Map();
  for (const source of configs) {
    const directory = safePath(source.root, `${source.directory}/kits`);
    for (const folder of exists(directory)
      ? fs.readdirSync(directory).sort()
      : []) {
      const dir = safePath(directory, folder);
      if (!fs.statSync(dir).isDirectory()) continue;
      const manifest = `${source.directory}/kits/${folder}/kit.yaml`;
      const kit: Kit = {
        ...parse(kitSchema, readYaml(source.root, manifest), manifest),
        directory: dir,
        ...(source.personal ? { origin: 'personal' as const } : {}),
      };
      if (kits.has(kit.id))
        throw new Error(
          `Duplicate kit ID: ${kit.id}. Personal and repository kits must have distinct IDs.`,
        );
      validateKit(kit);
      kits.set(kit.id, kit);
    }
  }
  const subscribed = subscriptions(root, global);
  const identities = new Map<string, string>();
  for (const subscription of subscribed) {
    const manifest = readCatalogCache(subscription.url)?.manifest;
    if (!manifest) continue;
    const other = identities.get(manifest.id);
    if (other && other !== subscription.url)
      throw new Error(
        `Catalog ID ${manifest.id} is also published at ${other}`,
      );
    identities.set(manifest.id, subscription.url);
    for (const provider of manifest.providers)
      for (const definition of provider.kits) {
        // Existing explicit source pins continue to override catalog offers.
        if (externalKits.some((kit) => kit.id === definition.id)) continue;
        if (kits.has(definition.id))
          throw new Error(
            `Duplicate kit ID: ${definition.id}. Catalogs must use distinct kit IDs.`,
          );
        kits.set(definition.id, {
          ...externalKit(definition, root),
          origin: 'catalog',
          catalog: {
            id: manifest.id,
            url: subscription.url,
            name: manifest.name,
            provider: provider.id,
            description: provider.description,
            prefix: provider.prefix,
          },
          subscriptions: subscription.scopes,
        });
      }
  }
  for (const definition of externalKits) {
    if (kits.has(definition.id))
      throw new Error(
        `Duplicate kit ID: ${definition.id}. Local and external kits must have distinct IDs.`,
      );
    kits.set(definition.id, externalKit(definition, root));
  }
  const installed =
    JSON.parse(
      readOptional(root, '.loadout-personal/generated.json')?.toString() ??
        '{}',
    ).installedAt ?? {};
  for (const [id, snapshot] of Object.entries(readExternal(root).store.kits)) {
    let kit = kits.get(id);
    if (
      snapshot.registration?.catalog &&
      kit &&
      (!kit.external ||
        (kit.catalog && snapshot.registration.catalog.id !== kit.catalog.id))
    ) {
      if (Object.hasOwn(installed, id))
        throw new Error(
          `Installed kit ${id} belongs to catalog ${snapshot.registration.catalog.id}, not ${kit.catalog?.id ?? 'a local kit'}`,
        );
      continue;
    }
    if (!kit && Object.hasOwn(installed, id)) {
      kit = {
        ...externalKit(
          {
            id,
            description:
              snapshot.registration?.description ??
              `${id} (saved installation)`,
            source: snapshot.source,
          },
          root,
        ),
        catalog: snapshot.registration?.catalog,
        origin: snapshot.registration?.catalog ? 'catalog' : 'external',
        unavailable: true,
      };
      kits.set(id, kit);
    }
    if (kit?.external) {
      kit.pinned = snapshot.source;
      if (
        !snapshot.source.integrity &&
        kit.external.integrity &&
        kitIntegrity(snapshot) === kit.external.integrity
      )
        kit.pinned = { ...snapshot.source, integrity: kit.external.integrity };
      if (snapshot.source.kit || kit.external.kit) {
        kit.offered = kit.external;
        Object.assign(
          kit,
          { ready: undefined, requires: [], questions: {}, outputs: [] },
          snapshot.source.kit?.manifest,
          {
            external: snapshot.source,
            resources: snapshot.source.kit
              ? snapshotResources(snapshot)
              : undefined,
          },
        );
      }
    }
  }
  const catalog = { root, kits, global, subscriptions: subscribed };
  for (const kit of kits.values()) {
    if (kit.origin !== 'catalog' || kit.ready === false) continue;
    try {
      resolveKits(catalog, [kit.id]);
    } catch (error) {
      kit.problem = (error as Error).message;
      kit.ready = false;
    }
  }
  resolveKits(
    catalog,
    [...kits.values()]
      .filter((kit) => kit.ready !== false && kit.origin !== 'catalog')
      .map((kit) => kit.id),
  );
  return catalog;
}

function externalKit(definition: ExternalKit, root: string): Kit {
  const source = definition.source;
  const cached = source.kit ? readSharedSnapshot(source) : undefined;
  return {
    schemaVersion: 1,
    requires: [],
    questions: {},
    outputs: [],
    ...source.kit?.manifest,
    id: definition.id,
    description: definition.description,
    directory: root,
    external: source,
    origin: 'external',
    ...(cached ? { resources: snapshotResources(cached) } : {}),
  };
}
