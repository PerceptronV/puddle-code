import { z } from 'zod';
import { runtimeIdentitySchema } from '../protocol.js';
import { huddleRevisionSchema } from '../../api/huddle/events.js';

/** Host-produced recovery provenance; no browser supplies filesystem paths or launch identities. */
export const huddleRecoverySchema = z
  .strictObject({
    format: z.literal(1),
    source: runtimeIdentitySchema,
    sourceBoot: z.uuid(),
    boot: z.uuid(),
    ancestors: z.array(runtimeIdentitySchema).max(32),
    seed: huddleRevisionSchema,
  })
  .refine(
    (value) =>
      value.sourceBoot !== value.boot &&
      new Set([value.source.runtime_id, ...value.ancestors.map((owner) => owner.runtime_id)])
        .size ===
        value.ancestors.length + 1,
    'Recovery needs a later boot and unique predecessor identities',
  );
export type HuddleRecovery = z.infer<typeof huddleRecoverySchema>;
