import { huddleRecoverySchema } from './recovery.js';
import {
  huddleLifecycleOperationSchema,
  huddleLifecyclePageSchema,
} from './operations/lifecycle.js';
import { z } from 'zod';
import { huddleTriggerReportSchema } from '../../api/huddle/triggers.js';
import {
  huddleSessionFeedCursorSchema,
  huddleSessionFeedPageSchema,
} from './triggers/session-feed.js';
import { huddleSessionSourceSchema, HUDDLE_SESSION_SOURCE_LIMIT } from './triggers/sessions.js';
import {
  huddleCompletionSourceSchema,
  huddleCompletionBaselinesSchema,
  HUDDLE_COMPLETION_SOURCE_LIMIT,
  huddleCompletionPlanSchema,
} from './triggers/completions.js';
import { runtimeNativeTurnPageSchema } from '../native-turns.js';
import { runtimeIdentitySchema } from '../protocol.js';
import { huddleJsonSchema, huddleKeySchema } from '../../api/huddle/values.js';
import { huddleLedgerIdentitySchema } from './state.js';
import { huddleControlStateSchema, huddleRevisionActivationSchema } from './revisions.js';
import { huddleRuntimeCapabilitiesSchema } from './capabilities.js';
import {
  huddleAgentOutcomeSchema,
  huddleAgentOperationSchema,
  huddleOperationPageSchema,
} from './operations/mailbox.js';
import { huddleTurnScopeSchema } from './operations/agents.js';
import { huddleSpawnOutcomeSchema, huddleSpawnScopeSchema } from './operations/spawns.js';
import {
  huddleSpawnOperationSchema,
  huddleSpawnPageSchema,
  huddleSpawnCleanupOutcomeSchema,
} from './operations/spawn-mailbox.js';
import { huddleCustomTriggerViewSchema, HUDDLE_CUSTOM_TRIGGER_LIMIT } from './triggers/custom.js';

/** Unshipped role contract. No agent/terminal message or retained record changes. */
export const HUDDLE_OWNER_CONTRACT = 1 as const;
const sequence = z.number().int().nonnegative().safe();
export const huddleActivationInputSchema = huddleRevisionActivationSchema.omit({ appliedAt: true });
export type HuddleActivationInput = z.infer<typeof huddleActivationInputSchema>;
export const huddleOwnerLaunchSchema = z
  .strictObject({
    format: z.literal(1),
    role: z.literal('huddle'),
    contract: z.literal(HUDDLE_OWNER_CONTRACT),
    capabilities: huddleRuntimeCapabilitiesSchema,
    identity: runtimeIdentitySchema,
    scope: huddleLedgerIdentitySchema,
    secret: z.string().regex(/^[a-f0-9]{64}$/),
    build: z.string().min(1).max(128),
    boot_id: z.uuid().optional(),
    lifetime: z.enum(['service', 'host_session']),
    initial: huddleActivationInputSchema,
    recovery: huddleRecoverySchema.optional(),
  })
  .superRefine((launch, ctx) => {
    const { identity, scope } = launch;
    if (
      launch.recovery &&
      (launch.capabilities.recovery !== 1 ||
        launch.boot_id !== launch.recovery.boot ||
        [launch.recovery.source, ...launch.recovery.ancestors].some(
          (owner) =>
            owner.runtime_id === identity.runtime_id ||
            owner.profile_id !== identity.profile_id ||
            owner.project_id !== identity.project_id ||
            owner.session_id !== identity.session_id ||
            owner.canonical_worktree_path !== identity.canonical_worktree_path,
        ))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Recovery lineage differs from its new owner placement',
      });
    if (
      scope.runtimeId !== identity.runtime_id ||
      scope.profileId !== identity.profile_id ||
      scope.projectId !== identity.project_id ||
      scope.sessionId !== identity.session_id ||
      launch.initial.worktree !== identity.canonical_worktree_path
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Huddle launch scope differs from its runtime identity',
      });
  });
export type HuddleOwnerLaunch = z.infer<typeof huddleOwnerLaunchSchema>;

export const huddleOwnerStateSchema = z
  .strictObject({
    format: z.literal(1),
    role: z.literal('huddle'),
    contract: z.literal(HUDDLE_OWNER_CONTRACT),
    capabilities: huddleRuntimeCapabilitiesSchema,
    identity: runtimeIdentitySchema,
    scope: huddleLedgerIdentitySchema,
    build: z.string().min(1).max(128),
    lifetime: z.enum(['service', 'host_session']),
    state: z.enum(['running', 'stopping', 'exited']),
    observation: sequence,
    persistencePending: z.boolean(),
    executing: z.boolean(),
    commandCursor: sequence,
    control: huddleControlStateSchema,
    liveWorkers: z.boolean(),
    failure: z.string().max(4096).nullable(),
    customTriggers: z
      .array(huddleCustomTriggerViewSchema)
      .max(HUDDLE_CUSTOM_TRIGGER_LIMIT)
      .optional(),
  })
  .superRefine(({ identity, scope }, ctx) => {
    if (
      scope.runtimeId !== identity.runtime_id ||
      scope.profileId !== identity.profile_id ||
      scope.projectId !== identity.project_id ||
      scope.sessionId !== identity.session_id
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Huddle observation scope differs from its runtime identity',
      });
  });
export type HuddleOwnerState = z.infer<typeof huddleOwnerStateSchema>;
const request = { id: z.uuid(), sequence };
export const huddleOwnerRequestSchema = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('hello'),
    id: z.uuid(),
    role: z.literal('huddle'),
    contract: z.literal(HUDDLE_OWNER_CONTRACT),
    identity: runtimeIdentitySchema,
    secret: huddleOwnerLaunchSchema.shape.secret,
    controllerId: z.uuid(),
    controllerEpoch: sequence,
  }),
  z.strictObject({ t: z.literal('inspect'), ...request }),
  z.strictObject({
    t: z.literal('trigger-inspect'),
    ...request,
    expectedGeneration: sequence,
    activationId: z.uuid().nullable(),
  }),
  z.strictObject({
    t: z.literal('readout-observe'),
    ...request,
    operationId: z.uuid(),
    expectedGeneration: sequence,
    activationId: z.uuid().nullable(),
  }),
  z.strictObject({ t: z.literal('completion-sources'), ...request }),
  z.strictObject({
    t: z.literal('completion-plan'),
    ...request,
    activation: huddleActivationInputSchema.optional(),
  }),
  z.strictObject({
    t: z.literal('completion-events'),
    ...request,
    source: huddleCompletionSourceSchema,
    page: runtimeNativeTurnPageSchema,
  }),
  z.strictObject({
    t: z.literal('completion-unavailable'),
    ...request,
    source: huddleCompletionSourceSchema,
    error: z.string().min(1).max(4096),
  }),
  z.strictObject({ t: z.literal('session-sources'), ...request }),
  z.strictObject({
    t: z.literal('session-events'),
    ...request,
    source: huddleSessionSourceSchema,
    page: huddleSessionFeedPageSchema,
  }),
  z.strictObject({
    t: z.literal('session-unavailable'),
    ...request,
    source: huddleSessionSourceSchema,
    error: z.string().min(1).max(4096),
  }),
  z.strictObject({ t: z.literal('operation-page'), ...request, after: sequence }),
  z.strictObject({ t: z.literal('spawn-page'), ...request, after: sequence }),
  z.strictObject({ t: z.literal('lifecycle-page'), ...request, after: sequence }),
  z.strictObject({ t: z.literal('lifecycle-claim'), ...request, operationId: z.uuid() }),
  z.strictObject({
    t: z.literal('lifecycle-settle'),
    ...request,
    scope: huddleSpawnScopeSchema,
    result: huddleSpawnOutcomeSchema,
  }),
  z.strictObject({
    t: z.literal('lifecycle-unavailable'),
    ...request,
    scope: huddleSpawnScopeSchema,
    unsent: z.boolean(),
    error: z.string().min(1).max(4096),
  }),
  z.strictObject({ t: z.literal('spawn-claim'), ...request, operationId: z.uuid() }),
  z.strictObject({
    t: z.literal('spawn-cleanup-settle'),
    ...request,
    scope: huddleSpawnScopeSchema,
    outcome: huddleSpawnCleanupOutcomeSchema,
  }),
  z.strictObject({
    t: z.literal('spawn-cleanup-unavailable'),
    ...request,
    scope: huddleSpawnScopeSchema,
    error: z.string().min(1).max(4096),
  }),
  z.strictObject({
    t: z.literal('spawn-unavailable'),
    ...request,
    scope: huddleSpawnScopeSchema,
    unsent: z.boolean(),
    error: z.string().min(1).max(4096),
  }),
  z.strictObject({
    t: z.literal('spawn-settle'),
    ...request,
    scope: huddleSpawnScopeSchema,
    result: huddleSpawnOutcomeSchema,
  }),
  z.strictObject({ t: z.literal('operation-claim'), ...request, operationId: z.uuid() }),
  z.strictObject({
    t: z.literal('operation-unavailable'),
    ...request,
    scope: huddleTurnScopeSchema,
    unsent: z.boolean(),
    error: z.string().min(1).max(4096),
  }),
  z.strictObject({
    t: z.literal('operation-settle'),
    ...request,
    scope: huddleTurnScopeSchema,
    result: huddleAgentOutcomeSchema,
  }),
  z.strictObject({
    t: z.literal('apply'),
    ...request,
    completionBaselines: huddleCompletionBaselinesSchema.optional(),
    feedBaseline: huddleSessionFeedCursorSchema.optional(),
    activation: huddleActivationInputSchema,
    expectedGeneration: sequence,
  }),
  z.strictObject({
    t: z.literal('arm'),
    ...request,
    completionBaselines: huddleCompletionBaselinesSchema.optional(),
    feedBaseline: huddleSessionFeedCursorSchema.optional(),
    expectedGeneration: sequence,
    autoStart: z.boolean(),
  }),
  z.strictObject({
    t: z.literal('auto-start'),
    ...request,
    expectedGeneration: sequence,
    activationId: z.uuid().nullable(),
    expected: z.boolean(),
    enabled: z.boolean(),
  }),
  z.strictObject({ t: z.literal('interrupt'), ...request }),
  z.strictObject({ t: z.literal('shutdown'), ...request }),
  z.strictObject({
    t: z.literal('run'),
    ...request,
    node: huddleKeySchema,
    eventId: z.string().min(1).max(256),
    data: huddleJsonSchema,
  }),
  z.strictObject({
    t: z.literal('records'),
    ...request,
    collection: z.enum(['executions', 'invocations', 'operations']),
    after: sequence,
    parent: z.string().max(256).optional(),
  }),
]);
export type HuddleOwnerRequest = z.infer<typeof huddleOwnerRequestSchema>;
export const huddleOwnerResponseSchema = z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('trigger-report'),
    id: z.uuid(),
    report: huddleTriggerReportSchema,
  }),
  z.strictObject({ t: z.literal('lifecycle-page'), id: z.uuid(), page: huddleLifecyclePageSchema }),
  z.strictObject({
    t: z.literal('lifecycle-claim'),
    id: z.uuid(),
    dispatch: z.boolean(),
    operation: huddleLifecycleOperationSchema,
  }),
  z.strictObject({
    t: z.literal('lifecycle-settled'),
    id: z.uuid(),
    operationId: z.uuid(),
    result: huddleSpawnOutcomeSchema,
  }),
  z.strictObject({ t: z.literal('changed'), observation: sequence }),
  z.strictObject({ t: z.literal('state'), id: z.uuid(), state: huddleOwnerStateSchema }),
  z.strictObject({ t: z.literal('accepted'), id: z.uuid() }),
  z.strictObject({
    t: z.literal('completion-plan'),
    id: z.uuid(),
    plan: huddleCompletionPlanSchema,
  }),
  z.strictObject({
    t: z.literal('completion-sources'),
    id: z.uuid(),
    sources: z.array(huddleCompletionSourceSchema).max(HUDDLE_COMPLETION_SOURCE_LIMIT),
  }),
  z.strictObject({
    t: z.literal('session-sources'),
    id: z.uuid(),
    sources: z.array(huddleSessionSourceSchema).max(HUDDLE_SESSION_SOURCE_LIMIT),
  }),
  z.strictObject({ t: z.literal('operation-page'), id: z.uuid(), page: huddleOperationPageSchema }),
  z.strictObject({ t: z.literal('spawn-page'), id: z.uuid(), page: huddleSpawnPageSchema }),
  z.strictObject({
    t: z.literal('spawn-cleaned'),
    id: z.uuid(),
    operationId: z.uuid(),
    outcome: huddleSpawnCleanupOutcomeSchema,
  }),
  z.strictObject({
    t: z.literal('spawn-claim'),
    id: z.uuid(),
    dispatch: z.boolean(),
    operation: huddleSpawnOperationSchema,
  }),
  z.strictObject({
    t: z.literal('spawn-settled'),
    id: z.uuid(),
    operationId: z.uuid(),
    result: huddleSpawnOutcomeSchema,
  }),
  z.strictObject({
    t: z.literal('operation-claim'),
    id: z.uuid(),
    dispatch: z.boolean(),
    operation: huddleAgentOperationSchema,
  }),
  z.strictObject({
    t: z.literal('operation-settled'),
    id: z.uuid(),
    operationId: z.uuid(),
    result: huddleAgentOutcomeSchema,
  }),
  z.strictObject({
    t: z.literal('run'),
    id: z.uuid(),
    executionId: z.uuid(),
    duplicate: z.boolean(),
  }),
  z.strictObject({
    t: z.literal('records'),
    id: z.uuid(),
    rows: z
      .array(
        z.strictObject({
          ordinal: sequence,
          id: z.string().max(256),
          body: z.string().max(1024 * 1024),
        }),
      )
      .max(256),
  }),
  z.strictObject({
    t: z.literal('error'),
    id: z.uuid(),
    code: z.enum(['fenced', 'rejected', 'duplicate']),
    message: z.string().max(4096),
  }),
]);
export type HuddleOwnerResponse = z.infer<typeof huddleOwnerResponseSchema>;
