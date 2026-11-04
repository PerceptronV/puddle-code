import { z } from 'zod';
import { hostStageRecordSchema } from '../../installation/stage.js';
import { runtimeTerminalSchema, RUNTIME_LIMITS } from '../../runtime/protocol.js';

const software = z
  .object({
    version: z.string().min(1).max(128),
    protocol: hostStageRecordSchema.shape.protocol,
  })
  .strict();

/** Placement-scoped presentation; no owner secrets, paths or process identifiers. */
export const sessionRuntimeInspectionSchema = z
  .object({
    runtime: software
      .extend({
        id: z.uuid(),
        connected: z.boolean(),
        lifetime: z.enum(['service', 'host_session', 'unknown']).optional(),
        terminals: z
          .array(z.object({ term: runtimeTerminalSchema.shape.term }).strict())
          .max(RUNTIME_LIMITS.terminals)
          .nullable(),
      })
      .strict()
      .nullable(),
    installed: software.nullable(),
    restart: z.discriminatedUnion('available', [
      z
        .object({ available: z.literal(true), fingerprint: z.string().regex(/^[0-9a-f]{64}$/) })
        .strict(),
      z
        .object({
          available: z.literal(false),
          reason: z.enum([
            'no_live_runtime',
            'runtime_unavailable',
            'runtime_changed',
            'release_unavailable',
            'conversation_unknown',
            'resume_unsupported',
            'worktree_missing',
            'state_not_saved',
          ]),
        })
        .strict(),
    ]),
  })
  .strict();
export const restartSessionRuntimeRequestSchema = z
  .object({
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type SessionRuntimeInspection = z.infer<typeof sessionRuntimeInspectionSchema>;
export type RestartSessionRuntimeRequest = z.infer<typeof restartSessionRuntimeRequestSchema>;
