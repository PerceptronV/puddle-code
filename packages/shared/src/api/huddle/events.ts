import { z } from 'zod';
import { isoTimestamp, profileId, projectId, sessionId } from '../common.js';
import { huddleIdSchema, huddleJsonSchema, huddleKeySchema } from './values.js';
import { huddleComponentIdSchema } from './components.js';

export const huddleRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const eventId = z.string().min(1).max(256);
const worktree = z.string().min(1).max(4096);

export const huddleResourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('worktree'), worktree }),
  z.strictObject({
    kind: z.literal('session'),
    worktree,
    sessionId,
    runtimeId: z.uuid().optional(),
  }),
  z.strictObject({
    kind: z.literal('turn'),
    worktree,
    sessionId,
    runtimeId: z.uuid(),
    segmentId: z.uuid(),
    turn: z.number().int().positive().safe(),
    nativeRef: z.string().min(1).max(200),
  }),
]);

/** Extensions supply source data; the owner supplies scope and causal authority. */
export const huddleTriggerEmissionSchema = z.strictObject({
  id: eventId,
  port: huddleKeySchema,
  occurredAt: isoTimestamp.optional(),
  data: huddleJsonSchema,
  nextCursor: huddleJsonSchema,
});
export type HuddleTriggerEmission = z.infer<typeof huddleTriggerEmissionSchema>;

export const huddleEventSchema = z.strictObject({
  format: z.literal(1),
  id: eventId,
  source: z.strictObject({
    node: huddleKeySchema,
    component: huddleComponentIdSchema,
    version: z.number().int().positive(),
  }),
  port: huddleKeySchema,
  observedAt: isoTimestamp,
  occurredAt: isoTimestamp.optional(),
  scope: z.strictObject({
    hostId: z.string().min(1).max(128),
    profileId,
    projectId,
    huddleId: huddleIdSchema,
    sessionId,
    runtimeId: z.uuid(),
  }),
  revision: huddleRevisionSchema,
  executionId: z.uuid(),
  causation: z
    .strictObject({ runtimeId: z.uuid(), executionId: z.uuid(), operationId: z.uuid() })
    .optional(),
  resource: huddleResourceSchema.optional(),
  data: huddleJsonSchema,
});
export type HuddleEvent = z.infer<typeof huddleEventSchema>;

export const huddleDeliverySchema = z.strictObject({
  format: z.literal(1),
  id: z.uuid(),
  idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/),
  event: huddleEventSchema,
  invocationId: z.uuid(),
  node: huddleKeySchema,
  port: huddleKeySchema,
  data: huddleJsonSchema,
});
export type HuddleDelivery = z.infer<typeof huddleDeliverySchema>;

export const huddleDeliveryResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('delivered'), receipt: huddleJsonSchema }),
  z.strictObject({ status: z.literal('failed'), message: z.string().min(1).max(4096) }),
  z.strictObject({ status: z.literal('unknown'), message: z.string().min(1).max(4096) }),
]);
export type HuddleDeliveryResult = z.infer<typeof huddleDeliveryResultSchema>;

export const huddleTriggerHealthSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ready') }),
  z.strictObject({ state: z.literal('closed') }),
  z.strictObject({ state: z.literal('degraded'), message: z.string().min(1).max(4096) }),
  z.strictObject({
    state: z.literal('gap'),
    message: z.string().min(1).max(4096),
    after: huddleJsonSchema,
  }),
]);
export type HuddleTriggerHealth = z.infer<typeof huddleTriggerHealthSchema>;
