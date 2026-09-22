import { resolveKits } from './resolve.js';
import {
  sameSource,
  offeredSource,
  sourceVersion,
  type Catalog,
  type Kit,
} from './schema.js';

export function hasUpdate(kit: Kit): boolean {
  return !!(
    kit.pinned &&
    offeredSource(kit) &&
    !sameSource(kit.pinned, offeredSource(kit)!)
  );
}

// Without a selection, include downloaded kits that are currently disabled.
export function availableUpdates(catalog: Catalog, selected?: string[]): Kit[] {
  const enabled = selected
    ? new Set(resolveKits(catalog, selected))
    : undefined;
  return [...catalog.kits.values()]
    .filter((kit) => hasUpdate(kit) && (!enabled || enabled.has(kit.id)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function updateDescription(kit: Kit): string {
  const before = kit.pinned!;
  const after = offeredSource(kit)!;
  return [
    `${before.repo}@${sourceVersion(before).slice(0, 12)} → ${after.repo}@${sourceVersion(after).slice(0, 12)}`,
    ...(before.license !== after.license
      ? [`License: ${before.license} → ${after.license}`]
      : []),
    ...(JSON.stringify([...before.skills].sort()) !==
    JSON.stringify([...after.skills].sort())
      ? [`Skills: ${before.skills.join(', ')} → ${after.skills.join(', ')}`]
      : []),
  ].join('\n  ');
}
