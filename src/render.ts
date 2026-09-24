import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { agents, type Catalog, type State } from './schema.js';
import { safePath, walk, portableMode, exists } from './fs.js';
import { resolveKits } from './resolve.js';

export type FileContent = { content: Buffer; mode: number };
export type Rendered = {
  files: Map<string, FileContent>;
  skillRoots: Set<string>;
  instructionGroups: { paths: string[]; kits: string[] }[];
  skillKits: Set<string>;
  outputs?: { key: string; kit: string; paths: string[] }[];
  inherited?: Set<string>;
  inheritedPaths?: Set<string>;
  external?: { before?: Buffer; content: Buffer };
};
export function render(
  catalog: Catalog,
  state: State,
  inherited: ReadonlySet<string> = new Set(),
): Rendered {
  const files = new Map<string, FileContent>();
  const skillRoots = new Set<string>();
  const skillKits = new Set<string>();
  const instructionGroups: Rendered['instructionGroups'] = [];
  const instructionKits = new Map<string, Set<string>>();
  const sections = new Map<string, string[]>();
  const outputs: NonNullable<Rendered['outputs']> = [];
  const inheritedKits = new Set<string>();
  const inheritedPaths = new Set<string>();
  for (const id of resolveKits(catalog, state.selected)) {
    const kit = catalog.kits.get(id)!;
    for (const output of kit.outputs) {
      if (
        output.when &&
        state.answers[id]?.[output.when.answer] !== output.when.equals
      )
        continue;
      const source = kit.resources
        ? output.source
        : safePath(kit.directory, output.source);
      if (output.type === 'instructions') {
        if (catalog.global && output.scope !== '.')
          throw new Error(`${kit.id}: global instructions must use scope: .`);
        if (output.scope !== '.') {
          const scope = safePath(catalog.root, output.scope);
          if (!exists(scope) || !fs.statSync(scope).isDirectory())
            throw new Error(
              `${kit.id}: scope directory does not exist: ${output.scope}`,
            );
        }
        const section = (
          kit.resources
            ? kit.resources[output.source]?.content
            : fs.readFileSync(source)
        )
          ?.toString('utf8')
          .trim();
        if (section === undefined)
          throw new Error(`${kit.id}: missing ${output.source}`);
        const key = createHash('sha256')
          .update(`instructions\0${section}`)
          .digest('hex');
        if (!catalog.global && inherited.has(key)) {
          inheritedKits.add(id);
          inheritedPaths.add(path.posix.join(output.scope, 'AGENTS.md'));
          inheritedPaths.add(path.posix.join(output.scope, 'CLAUDE.md'));
          continue;
        }
        outputs.push({
          key,
          kit: id,
          paths: catalog.global
            ? ['.codex/AGENTS.md', '.claude/CLAUDE.md']
            : [
                path.posix.join(output.scope, 'AGENTS.md'),
                path.posix.join(output.scope, 'CLAUDE.md'),
              ],
        });
        const kits = instructionKits.get(output.scope) ?? new Set<string>();
        kits.add(id);
        instructionKits.set(output.scope, kits);
        sections.set(output.scope, [
          ...(sections.get(output.scope) ?? []),
          section,
        ]);
      } else {
        const content = new Map<string, FileContent>();
        const sourceFiles = kit.resources
          ? Object.keys(kit.resources)
              .filter((file) => file.startsWith(`${output.source}/`))
              .map((file) => file.slice(output.source.length + 1))
          : walk(source);
        for (const file of sourceFiles) {
          const resource = kit.resources?.[`${output.source}/${file}`];
          const src = resource ? undefined : safePath(source, file);
          content.set(file, {
            content: resource?.content ?? fs.readFileSync(src!),
            mode: portableMode(
              (resource?.mode ?? fs.statSync(src!).mode) & 0o111
                ? 0o755
                : 0o644,
            ),
          });
        }
        if (kit.resources?.['LICENSE.upstream']) {
          if (content.has('LICENSE.upstream'))
            throw new Error(
              `Output collision: ${path.basename(source)}/LICENSE.upstream`,
            );
          content.set('LICENSE.upstream', kit.resources['LICENSE.upstream']);
        }
        const key = createHash('sha256')
          .update(
            JSON.stringify([
              'skill',
              path.basename(source),
              [...content]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([file, value]) => [
                  file,
                  value.mode,
                  value.content.toString('base64'),
                ]),
            ]),
          )
          .digest('hex');
        if (!catalog.global && inherited.has(key)) {
          inheritedKits.add(id);
          for (const agent of ['.agents', '.claude'])
            for (const file of content.keys())
              inheritedPaths.add(
                `${agent}/skills/${path.basename(source)}/${file}`,
              );
          continue;
        }
        skillKits.add(id);
        const paths: string[] = [];
        for (const agent of agents) {
          const destination = `${agent === 'codex' ? '.agents' : '.claude'}/skills/${path.basename(source)}`;
          if (skillRoots.has(destination))
            throw new Error(
              `Output collision: multiple skills target ${destination}`,
            );
          skillRoots.add(destination);
          for (const [file, value] of content) {
            files.set(`${destination}/${file}`, value);
            paths.push(`${destination}/${file}`);
          }
        }
        outputs.push({ key, kit: id, paths });
      }
    }
  }
  for (const [scope, content] of sections) {
    const instructions = catalog.global
      ? '.codex/AGENTS.md'
      : path.posix.join(scope, 'AGENTS.md');
    const claude = catalog.global
      ? '.claude/CLAUDE.md'
      : path.posix.join(scope, 'CLAUDE.md');
    if (files.has(instructions) || files.has(claude))
      throw new Error(`Output collision: ${scope}`);
    instructionGroups.push({
      paths: [instructions, claude],
      kits: [...instructionKits.get(scope)!],
    });
    files.set(instructions, {
      content: Buffer.from(`${content.join('\n\n')}\n`),
      mode: 0o644,
    });
    // Imports resolve beside CLAUDE.md, including within nested scopes.
    files.set(claude, {
      content: Buffer.from(
        catalog.global ? '@../.codex/AGENTS.md\n' : '@AGENTS.md\n',
      ),
      mode: 0o644,
    });
  }
  return {
    files: new Map([...files].sort(([a], [b]) => a.localeCompare(b))),
    skillRoots,
    instructionGroups,
    skillKits,
    outputs,
    inherited: inheritedKits,
    inheritedPaths,
  };
}
