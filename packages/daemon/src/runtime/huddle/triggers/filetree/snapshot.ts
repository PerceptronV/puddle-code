import { lstat, opendir, realpath } from 'node:fs/promises';
import { join, posix } from 'node:path';
import {
  HUDDLE_FILETREE_LIMITS,
  huddleFiletreeSnapshotSchema,
  huddleFiletreePathSchema,
  type HuddleFiletreeSettings,
  type HuddleFiletreeSnapshot,
} from '@puddle/shared';
import { requireFiletreeRoot } from './definitions.js';

export function excludedFiletreePath(settings: HuddleFiletreeSettings, relative: string) {
  const scoped = settings.directory === '.' ? relative : `${settings.directory}/${relative}`;
  const parts = scoped.split('/');
  if (
    parts.includes('.git') ||
    parts.some((part, index) => part === '.puddle' && parts[index + 1] === 'huddle')
  )
    return true;
  if (settings.outputPaths.some((path) => scoped === path || scoped.startsWith(`${path}/`)))
    return true;
  return settings.exclude.some(
    (pattern) => posix.matchesGlob(relative, pattern) || posix.matchesGlob(`${relative}/`, pattern),
  );
}

/** Stream directory entries and lstat metadata; never read file contents or follow symlinks. */
export async function scanFiletree(
  settings: HuddleFiletreeSettings,
  signal: AbortSignal,
  directory: (path: string, relative: string, identity: string) => void,
) {
  const root = requireFiletreeRoot(settings),
    started = performance.now();
  const snapshot: HuddleFiletreeSnapshot = [],
    directories = new Set<string>();
  let entries = 0;
  const check = () => {
    signal.throwIfAborted();
    if (performance.now() - started > HUDDLE_FILETREE_LIMITS.scanMs)
      throw new Error('Filetree scan exceeded 10 seconds; narrow its directory or filters');
  };
  const visit = async (path: string, relative: string) => {
    check();
    const identity = await lstat(path, { bigint: true });
    check();
    if (!identity.isDirectory() || identity.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error('Filetree directory changed during reconciliation');
    check();
    if (directories.size >= HUDDLE_FILETREE_LIMITS.directories)
      throw new Error('Filetree exceeds 128 watched directories; narrow its scope');
    directories.add(path);
    directory(path, relative, `${identity.dev}:${identity.ino}`);
    const handle = await opendir(path);
    try {
      for await (const entry of handle) {
        check();
        if (++entries > HUDDLE_FILETREE_LIMITS.entries)
          throw new Error('Filetree scan exceeds 8192 entries; narrow its scope');
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (excludedFiletreePath(settings, child)) continue;
        huddleFiletreePathSchema.parse(
          settings.directory === '.' ? child : `${settings.directory}/${child}`,
        );
        const childPath = join(path, entry.name);
        try {
          const stat = await lstat(childPath, { bigint: true });
          check();
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) await visit(childPath, child);
          else if (
            stat.isFile() &&
            settings.include.some((pattern) => posix.matchesGlob(child, pattern))
          ) {
            snapshot.push({
              path: settings.directory === '.' ? child : `${settings.directory}/${child}`,
              signature: `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
            });
            if (snapshot.length > HUDDLE_FILETREE_LIMITS.files)
              throw new Error('Filetree exceeds 1024 matched files; narrow its scope');
          }
        } catch (error) {
          // An entry removed during this scan is absent from this net observation.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    } finally {
      await handle.close().catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ERR_DIR_CLOSED') throw error;
      });
    }
    check();
    if ((await realpath(path)) !== path)
      throw new Error('Filetree directory moved during reconciliation');
  };
  await visit(root, '');
  check();
  requireFiletreeRoot(settings);
  snapshot.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { snapshot: huddleFiletreeSnapshotSchema.parse(snapshot), directories };
}

export function filetreeChanges(before: HuddleFiletreeSnapshot, after: HuddleFiletreeSnapshot) {
  const old = new Map(before.map((file) => [file.path, file.signature]));
  const next = new Map(after.map((file) => [file.path, file.signature]));
  return [...new Set([...old.keys(), ...next.keys()])].sort().flatMap((path) => {
    if (old.get(path) === next.get(path)) return [];
    return [
      {
        path,
        kind: !next.has(path)
          ? ('remove' as const)
          : !old.has(path)
            ? ('create' as const)
            : ('change' as const),
      },
    ];
  });
}
