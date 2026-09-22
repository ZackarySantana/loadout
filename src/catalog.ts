import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as yaml } from 'yaml';
import {
  configSchema,
  kitSchema,
  parse,
  validAnswer,
  idSchema,
  type Catalog,
  type Kit,
} from './schema.js';
import { exists, safePath, walk } from './fs.js';
import { curatedKits } from './curated.js';
import { resolveKits } from './resolve.js';
import { bundledRoot } from './bundled.js';

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
  const home = fs.realpathSync(os.homedir());
  const sources = [
    ...(!global && root !== home
      ? [
          { root: home, directory: '.loadout', personal: true },
          { root: home, directory: '.loadout-personal', personal: true },
        ]
      : []),
    { root, directory: '.loadout', personal: global },
    { root, directory: '.loadout-personal', personal: true },
  ];
  const configs = sources.map((source) => {
    const file = `${source.directory}/config.yaml`;
    const present = exists(safePath(source.root, file));
    return {
      ...source,
      present,
      config: parse(
        configSchema,
        present ? readYaml(source.root, file) : { schemaVersion: 1 },
        `${source.root}/${file}`,
      ),
    };
  });
  const config = {
    curated:
      [...configs].reverse().find((source) => source.present)?.config.curated ??
      true,
    externalKits: configs.flatMap(({ config }) => config.externalKits),
  };
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
  for (const [definitions, origin] of [
    [config.curated ? curatedKits : [], 'curated'],
    [config.externalKits, 'external'],
  ] as const) {
    for (const definition of definitions) {
      if (
        origin === 'curated' &&
        config.externalKits.some((kit) => kit.id === definition.id)
      )
        continue;
      if (kits.has(definition.id))
        throw new Error(
          `Duplicate kit ID: ${definition.id}. Local and external kits must have distinct IDs.`,
        );
      kits.set(definition.id, {
        schemaVersion: 1,
        id: definition.id,
        description: definition.description,
        requires: [],
        questions: {},
        outputs: [],
        directory: root,
        external: definition.source,
        origin,
      });
    }
  }
  if (config.curated) {
    for (const provider of fs.readdirSync(bundledRoot).sort()) {
      const directory = safePath(bundledRoot, provider);
      if (!fs.statSync(directory).isDirectory()) continue;
      parse(idSchema, provider, 'Bundled provider');
      for (const folder of fs.readdirSync(directory).sort()) {
        const dir = safePath(directory, folder);
        if (!fs.statSync(dir).isDirectory()) continue;
        const manifest = `${provider}/${folder}/kit.yaml`;
        const definition = parse(
          kitSchema,
          readYaml(bundledRoot, manifest),
          manifest,
        );
        const kit: Kit = {
          ...definition,
          id: `loadout-${definition.id}`,
          requires: definition.requires.map((id) => `loadout-${id}`),
          directory: dir,
          origin: 'bundled',
          provider,
        };
        if (kits.has(kit.id)) throw new Error(`Duplicate kit ID: ${kit.id}`);
        validateKit(kit);
        kits.set(kit.id, kit);
      }
    }
  }
  const catalog = { root, kits, global };
  resolveKits(
    catalog,
    [...kits.values()]
      .filter((kit) => kit.ready !== false)
      .map((kit) => kit.id),
  );
  return catalog;
}
