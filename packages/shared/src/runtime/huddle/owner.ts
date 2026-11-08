import { z } from 'zod';
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
  })
  .superRefine((launch, ctx) => {
    const { identity, scope } = launch;
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
  z.strictObject({ t: z.literal('operation-page'), ...request, after: sequence }),
  z.strictObject({ t: z.literal('operation-claim'), ...request, operationId: z.uuid() }),
  z.strictObject({
    t: z.literal('operation-settle'),
    ...request,
    scope: huddleTurnScopeSchema,
    result: huddleAgentOutcomeSchema,
  }),
  z.strictObject({
    t: z.literal('apply'),
    ...request,
    activation: huddleActivationInputSchema,
    expectedGeneration: sequence,
  }),
  z.strictObject({
    t: z.literal('arm'),
    ...request,
    expectedGeneration: sequence,
    autoStart: z.boolean(),
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
  z.strictObject({ t: z.literal('changed'), observation: sequence }),
  z.strictObject({ t: z.literal('state'), id: z.uuid(), state: huddleOwnerStateSchema }),
  z.strictObject({ t: z.literal('accepted'), id: z.uuid() }),
  z.strictObject({ t: z.literal('operation-page'), id: z.uuid(), page: huddleOperationPageSchema }),
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
