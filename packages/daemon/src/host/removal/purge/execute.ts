import { lstatSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { HostPurgeRecord } from '@puddle/shared';
import { privateDirectory, syncPrivateDirectory } from '@puddle/shared/node';
import type { HostRemovalGuard } from '../guard.js';
import { OWNED_TREE_FILE_BUDGET, pruneOwnedTree } from '../../installation/tree.js';
import { writeHostPurge } from './records.js';
import { requireNoRuntimeMemoryGrants } from '../../../runtime/resources/host/retirement.js';

export async function executePurgeData(
  guard: HostRemovalGuard,
  record: HostPurgeRecord,
  current: () => void,
) {
  requireNoRuntimeMemoryGrants(guard.home);
  const directory = join(guard.home, 'installation/removal');
  const quarantine = join(directory, 'purge-data');
  privateDirectory(quarantine);
  const budget = { remaining: OWNED_TREE_FILE_BUDGET };
  const stat = (path: string) => {
    try {
      return lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const matches = (
    root: HostPurgeRecord['roots'][number],
    info: NonNullable<ReturnType<typeof stat>>,
  ) => {
    if (
      info.dev !== root.device ||
      info.ino !== root.inode ||
      info.uid !== process.getuid?.() ||
      (root.kind === 'directory'
        ? !info.isDirectory()
        : root.kind === 'file'
          ? !info.isFile()
          : !info.isSymbolicLink())
    )
      throw new Error('Reviewed purge root changed');
  };
  // Detach every reviewed root before incremental deletion. Later writes at the
  // original paths are outside this purge's approval and must never be swept up.
  for (let index = 0; index < record.roots.length; index++) {
    current();
    const root = record.roots[index]!;
    if (root.state === 'deleted') continue;
    const source = join(guard.home, root.name);
    const target = join(quarantine, String(index));
    if (root.state === 'planned') {
      const from = stat(source);
      const to = stat(target);
      if (from) {
        matches(root, from);
        if (to) throw new Error('Purge quarantine is occupied');
        current();
        renameSync(source, target);
      } else if (!to) throw new Error('Reviewed purge data disappeared before detachment');
      matches(root, stat(target)!);
      syncPrivateDirectory(guard.home);
      syncPrivateDirectory(quarantine);
      root.state = 'detached';
      writeHostPurge(guard.home, record);
    }
  }
  for (let index = 0; index < record.roots.length; index++) {
    current();
    const root = record.roots[index]!;
    if (root.state === 'deleted') continue;
    const target = join(quarantine, String(index));
    const detached = stat(target);
    if (detached) {
      matches(root, detached);
      if (!budget.remaining) return;
      if (root.kind === 'directory') {
        if (!(await pruneOwnedTree(target, root, current, budget, { allowSockets: true }))) return;
      } else {
        current();
        unlinkSync(target);
        budget.remaining--;
      }
    }
    syncPrivateDirectory(quarantine);
    root.state = 'deleted';
    writeHostPurge(guard.home, record);
  }
  current();
  // Retain the receipt and permanent locks, but allow an explicit fresh install.
  if (stat(join(directory, 'services.json')))
    renameSync(join(directory, 'services.json'), join(directory, 'purged-services.json'));
  syncPrivateDirectory(directory);
  record.phase = 'complete';
  writeHostPurge(guard.home, record);
  renameSync(join(directory, 'purge.json'), join(directory, 'purged.json'));
  syncPrivateDirectory(directory);
}
