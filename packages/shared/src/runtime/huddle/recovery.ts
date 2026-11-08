import { z } from 'zod';
import { runtimeIdentitySchema } from '../protocol.js';
import { huddleRevisionSchema } from '../../api/huddle/events.js';

export const HUDDLE_AUTOMATIC_RECOVERY_LIMIT = 3;

export const huddleContainmentSchema = z.strictObject({
  format: z.literal(1),
  identity: runtimeIdentitySchema,
  boot: z.uuid(),
  kind: z.literal('cgroup-v2'),
  path: z.string().min(1).max(4096),
  device: z.string().regex(/^[0-9]+$/),
  inode: z.string().regex(/^[0-9]+$/),
  namespace: z.string().regex(/^cgroup:\[[0-9]+\]$/),
});
export type HuddleContainment = z.infer<typeof huddleContainmentSchema>;

/** Host-produced recovery provenance; no browser supplies filesystem paths or launch identities. */
export const huddleRecoverySchema = z
  .strictObject({
    format: z.literal(1),
    source: runtimeIdentitySchema,
    sourceBoot: z.uuid(),
    boot: z.uuid(),
    ancestors: z.array(runtimeIdentitySchema).max(32),
    seed: huddleRevisionSchema,
    containment: huddleContainmentSchema.optional(),
    automaticAttempts: z.number().int().min(1).max(HUDDLE_AUTOMATIC_RECOVERY_LIMIT).optional(),
  })
  .refine(
    (value) =>
      (value.automaticAttempts === undefined || value.containment !== undefined) &&
      (value.sourceBoot !== value.boot
        ? value.containment === undefined
        : value.containment !== undefined &&
          value.containment.boot === value.boot &&
          value.containment.identity.runtime_id === value.source.runtime_id) &&
      new Set([value.source.runtime_id, ...value.ancestors.map((owner) => owner.runtime_id)])
        .size ===
        value.ancestors.length + 1,
    'Recovery needs descendant fencing and unique predecessor identities',
  );
export type HuddleRecovery = z.infer<typeof huddleRecoverySchema>;
