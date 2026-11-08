import { opendir, realpath } from 'node:fs/promises';
import { huddleIdSchema, type HuddleComponent, type HuddleDiagnostic } from '@puddle/shared';
import { captureHuddleDefinition } from './capture.js';
import { checkedHuddlePath } from './files.js';

export type HuddleDiscoveryEntry =
  | { id: string; name: string; digest: string; diagnostics: HuddleDiagnostic[]; error?: never }
  | { id: string; name?: never; digest?: never; diagnostics?: never; error: string };

/** A malformed sibling cannot hide healthy huddles; discovery never imports source. */
export async function discoverHuddleDefinitions(
  worktree: string,
  builtins?: ReadonlyMap<string, HuddleComponent>,
): Promise<HuddleDiscoveryEntry[]> {
  let root: string;
  try {
    root = await checkedHuddlePath(await realpath(worktree), '.puddle/huddle');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const ids: string[] = [];
  const directory = await opendir(root);
  let visited = 0;
  for await (const entry of directory) {
    if (++visited > 4096) throw new Error('Huddle collection directory limit exceeded');
    if (!huddleIdSchema.safeParse(entry.name).success) continue;
    if (ids.length >= 512)
      throw new Error('At most 512 huddle definitions can be discovered per worktree');
    ids.push(entry.name);
  }
  const entries: HuddleDiscoveryEntry[] = [];
  for (const id of ids.sort()) {
    try {
      const snapshot = await captureHuddleDefinition(worktree, id, builtins);
      // Do not retain every sibling's source bundle in a collection response.
      entries.push({
        id,
        name: snapshot.definition.name,
        digest: snapshot.digest,
        diagnostics: snapshot.diagnostics,
      });
    } catch (error) {
      entries.push({
        id,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 8192),
      });
    }
  }
  return entries;
}
