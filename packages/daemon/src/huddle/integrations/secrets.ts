import { constants, openSync, closeSync, fstatSync, readSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  huddleSecretReferenceSchema as reference,
  type HuddleComponent,
  type HuddleJson,
} from '@puddle/shared';

export interface HuddleSecretScope {
  profileId: string;
  projectId: string;
  huddleId: string;
  worktree: string;
}
const configuration = z.strictObject({
  format: z.literal(1),
  grants: z
    .array(
      z.strictObject({
        profileId: z.string().min(1).max(128),
        projectId: z.string().min(1).max(128),
        huddleId: z.string().regex(/^[a-f0-9]{32}$/),
        worktree: z.string().min(1).max(4096),
        values: z
          .record(reference, z.string().min(1).max(4096))
          .refine((values) => Object.keys(values).length <= 16),
      }),
    )
    .max(64),
});
const limit = 64 * 1024;

/** Read only this dedicated private file; never inspect account stores or process credentials. */
function readConfiguration(home: string) {
  const file = join(home, 'huddle-integrations.json');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n ||
      before.uid !== BigInt(process.getuid!()) ||
      before.size < 1n ||
      before.size > BigInt(limit)
    )
      throw new Error('Private configuration unavailable');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, count);
      if (!read) break;
      count += read;
    }
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(file, { bigint: true });
    if (
      count !== Number(before.size) ||
      [after, current].some(
        (stat) =>
          stat.dev !== before.dev ||
          stat.ino !== before.ino ||
          stat.size !== before.size ||
          stat.mtimeNs !== before.mtimeNs ||
          stat.ctimeNs !== before.ctimeNs,
      )
    )
      throw new Error('Private configuration changed');
    return configuration.parse(JSON.parse(bytes.subarray(0, count).toString('utf8')));
  } finally {
    closeSync(fd);
  }
}

/** Values are ephemeral worker input, never activation bindings, source or ledger records. */
export function huddleSecretResolver(home: string, scope: HuddleSecretScope) {
  return (
    component: HuddleComponent,
    parameters: Record<string, HuddleJson>,
  ): Record<string, string> => {
    const declared = Object.entries(component.parameters).filter(([, p]) => p.editor === 'secret');
    if (!declared.length) return {};
    const requested = declared.filter(([name]) => parameters[name] !== undefined);
    if (!requested.length) return {};
    try {
      const matches = readConfiguration(home).grants.filter(
        (grant) =>
          grant.profileId === scope.profileId &&
          grant.projectId === scope.projectId &&
          grant.huddleId === scope.huddleId &&
          grant.worktree === scope.worktree,
      );
      if (matches.length !== 1) throw new Error('Exact grant unavailable');
      const resolved = Object.fromEntries(
        requested.map(([name]) => {
          const key = reference.parse(parameters[name]);
          const values = matches[0]!.values;
          if (!Object.hasOwn(values, key)) throw new Error('Reference unavailable');
          return [name, values[key]!];
        }),
      );
      if (Buffer.byteLength(JSON.stringify(resolved)) > limit)
        throw new Error('Secret values exceed worker limit');
      return resolved;
    } catch {
      // No private path, parsed content, value or underlying OS diagnostic leaves this boundary.
      throw new Error(
        'Integration secrets unavailable: check the private host grant for this huddle and worktree',
      );
    }
  };
}
