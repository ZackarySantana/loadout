import fs from 'node:fs';
import path from 'node:path';
import { agents, type Catalog, type State } from './schema.js';
import { safePath, walk, portableMode, exists } from './fs.js';
import { resolveKits } from './resolve.js';

export type FileContent = { content: Buffer; mode: number };
export type Rendered = {
  files: Map<string, FileContent>;
  skillRoots: Set<string>;
  instructionGroups: { paths: string[]; kits: string[] }[];
  skillKits: Set<string>;
  external?: { before?: Buffer; content: Buffer };
};
export function render(catalog: Catalog, state: State): Rendered {
  const files = new Map<string, FileContent>();
  const skillRoots = new Set<string>();
  const skillKits = new Set<string>();
  const instructionGroups: Rendered['instructionGroups'] = [];
  const instructionKits = new Map<string, Set<string>>();
  const sections = new Map<string, string[]>();
  for (const id of resolveKits(catalog, state.selected)) {
    const kit = catalog.kits.get(id)!;
    if (kit.external) skillKits.add(id);
    for (const output of kit.outputs) {
      if (
        output.when &&
        state.answers[id]?.[output.when.answer] !== output.when.equals
      )
        continue;
      const source = safePath(kit.directory, output.source);
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
        const section = fs.readFileSync(source, 'utf8').trim();
        const kits = instructionKits.get(output.scope) ?? new Set<string>();
        kits.add(id);
        instructionKits.set(output.scope, kits);
        sections.set(output.scope, [
          ...(sections.get(output.scope) ?? []),
          section,
        ]);
      } else {
        skillKits.add(id);
        for (const agent of agents) {
          const destination = `${agent === 'codex' ? '.agents' : '.claude'}/skills/${path.basename(source)}`;
          if (skillRoots.has(destination))
            throw new Error(
              `Output collision: multiple skills target ${destination}`,
            );
          skillRoots.add(destination);
          for (const file of walk(source)) {
            const src = safePath(source, file);
            files.set(`${destination}/${file}`, {
              content: fs.readFileSync(src),
              mode: portableMode(fs.statSync(src).mode & 0o111 ? 0o755 : 0o644),
            });
          }
        }
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
  };
}
