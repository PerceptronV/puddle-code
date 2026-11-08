import { z } from 'zod';
import {
  huddleHistoryOwnersRequestSchema,
  huddleRetainedReadoutObserveSchema,
  huddleRetainedHistoryRequestSchema,
} from '../history.js';
import { sessionId } from '../../common.js';
import { huddleJsonSchema, HUDDLE_LIMITS } from '../values.js';
import {
  huddleRetainedRevisionRequestSchema,
  huddleRevisionReviewSchema,
  huddleDiffReviewSchema,
} from '../review.js';
import {
  huddleStartSchema,
  huddleAutoStartSchema,
  huddleRecoverSchema,
  huddleApplySchema,
  huddleRunSchema,
  huddleLifecycleCommandSchema,
  huddleHistoryRequestSchema,
  huddleReadoutObserveSchema,
} from '../execution.js';

const session = { session_id: sessionId };
/** All mutations carry reviewed values. Tools must never resolve a newer target implicitly. */
export const huddleExecutionToolSchemas = {
  runtime: z.strictObject(session),
  triggers: z.strictObject({ ...session, request: huddleLifecycleCommandSchema }),
  'auto-start': z.strictObject({ ...session, request: huddleAutoStartSchema }),
  recover: z.strictObject({ ...session, request: huddleRecoverSchema }),
  'retained-revision': z.strictObject({ ...session, request: huddleRetainedRevisionRequestSchema }),
  'history-owners': z.strictObject({ ...session, request: huddleHistoryOwnersRequestSchema }),
  'retained-history': z.strictObject({ ...session, request: huddleRetainedHistoryRequestSchema }),
  revision: z.strictObject({ ...session, request: huddleRevisionReviewSchema }),
  diff: z.strictObject({ ...session, request: huddleDiffReviewSchema }),
  start: z.strictObject({ ...session, request: huddleStartSchema }),
  apply: z.strictObject({ ...session, request: huddleApplySchema }),
  run: z.strictObject({ ...session, request: huddleRunSchema }),
  interrupt: z.strictObject({ ...session, request: huddleLifecycleCommandSchema }),
  resume: z.strictObject({ ...session, request: huddleLifecycleCommandSchema }),
  stop: z.strictObject({ ...session, request: huddleLifecycleCommandSchema }),
  history: z.strictObject({ ...session, request: huddleHistoryRequestSchema }),
  'observe-retained-readout': z.strictObject({
    ...session,
    request: huddleRetainedReadoutObserveSchema,
  }),
  'observe-readout': z.strictObject({ ...session, request: huddleReadoutObserveSchema }),
};
export const huddleToolExecutionCommandSchema = z.discriminatedUnion('action', [
  huddleExecutionToolSchemas.runtime.extend({ action: z.literal('runtime') }),
  huddleExecutionToolSchemas.triggers.extend({ action: z.literal('triggers') }),
  huddleExecutionToolSchemas['auto-start'].extend({ action: z.literal('auto-start') }),
  huddleExecutionToolSchemas.recover.extend({ action: z.literal('recover') }),
  huddleExecutionToolSchemas['retained-revision'].extend({
    action: z.literal('retained-revision'),
  }),
  huddleExecutionToolSchemas['history-owners'].extend({ action: z.literal('history-owners') }),
  huddleExecutionToolSchemas['retained-history'].extend({ action: z.literal('retained-history') }),
  huddleExecutionToolSchemas.revision.extend({ action: z.literal('revision') }),
  huddleExecutionToolSchemas.diff.extend({ action: z.literal('diff') }),
  huddleExecutionToolSchemas.start.extend({ action: z.literal('start') }),
  huddleExecutionToolSchemas.apply.extend({ action: z.literal('apply') }),
  huddleExecutionToolSchemas.run.extend({ action: z.literal('run') }),
  huddleExecutionToolSchemas.interrupt.extend({ action: z.literal('interrupt') }),
  huddleExecutionToolSchemas.resume.extend({ action: z.literal('resume') }),
  huddleExecutionToolSchemas.stop.extend({ action: z.literal('stop') }),
  huddleExecutionToolSchemas.history.extend({ action: z.literal('history') }),
  huddleExecutionToolSchemas['observe-retained-readout'].extend({
    action: z.literal('observe-retained-readout'),
  }),
  huddleExecutionToolSchemas['observe-readout'].extend({ action: z.literal('observe-readout') }),
]);
export type HuddleToolExecutionCommand = z.infer<typeof huddleToolExecutionCommandSchema>;

const definitions = [
  [
    'observe-retained-readout',
    'Observe one uncertain readout from its exact recorded owner and operation id (host 28.21+). Requires a confirmed cleanly stopped owner; recover interrupted owners first. Uses the captured observation adapter without redelivery or graph restart. Supply request {owner, operation_id}. Inspect retained history after acceptance or a lost reply; never retry automatically.',
    false,
  ],
  [
    'triggers',
    'Inspect installed trigger health, timer progress and retained accepted work for the exact target (host 28.17+ and a supporting owner). Supply request {target}. Per-source totals cover the active activation; global backlog also includes older activations. Does not observe new external events, reset cursors or reopen subscriptions. No execution or retry.',
    true,
  ],
  [
    'auto-start',
    'Set whether the current huddle run recovers automatically when the host starts after a verified reboot (host 28.16+). Supply request {target, expected, enabled}; expected is the inspected auto_start value. Does not arm a stopped graph, reset schedules/cursors or restart any process. Stop, Interrupt and Archive suppress startup even when enabled. This preference belongs to the current run; a fresh Start defaults off. Inspect after a failed reply; never retry automatically.',
    false,
  ],
  [
    'recover',
    'Recover the exact recorded huddle owner after a verified host reboot (host 28.15+). Supply request {owner: {runtimeId, incarnation}} from runtime recovery inspection. Restores the last active source, queued events and trigger cursors; interrupted scripts are not replayed. May resume automatic triggers. For same-boot owner crashes on Linux cgroup v2, supply after: "owner-crash" (host 28.18+ and a supporting owner); recovery requires recorded containment and positive descendant-exit evidence. Omitting after retains reboot-only behaviour. Never retry after a lost reply; inspect runtime/history.',
    false,
  ],
  [
    'retained-revision',
    'Read source and contracts from an exact recorded owner without restarting it. Supply owner; omit revision for the last recorded activation and settings, or supply an execution revision digest for its immutable source. Optional entry selects text; expected_digest compares to that exact saved source. Recorded state is not live or Apply authority. No execution, repair or retry.',
    true,
  ],
  [
    'history-owners',
    'List a bounded page of recorded runtime identities for this huddle placement, including stopped and older owners. Supply request {} for the first page or its after cursor. Recorded states do not prove liveness. No owner is started.',
    true,
  ],
  [
    'retained-history',
    'Read recorded executions, invocations or operations from the exact retained owner ledger. Supply owner, collection, after and parent where required. Works without a connected owner or project source; running/unknown records are not completion or live-state evidence. No execution, reconciliation or retry.',
    true,
  ],
  [
    'revision',
    'Inspect the exact active huddle revision, variables, resolved bindings and source/contract inventory. Supply the inspected target, optionally entry {kind: file|component, path} for retained text. Works without saved source while the owner is connected. Does not execute, save or apply.',
    true,
  ],
  [
    'diff',
    'Compare saved source against the exact active huddle revision. Supply reviewed target and expected_digest from source inspection; optional entry {kind: file|component, path} returns before/after text. Reports changes to scripts and resolved contracts as well as graph/layout files. No execution or Apply; stale targets/digests fail without automatic refresh.',
    true,
  ],
  [
    'runtime',
    'Inspect the huddle placement and its exact connected owner target. Includes readout support and custom-trigger health on supporting hosts. Does not start or adopt an owner.',
    true,
  ],
  [
    'start',
    'Start the explicitly reviewed saved digest with explicit variables. Arms automatic triggers and can execute trusted code. Does not save source. After any failed reply inspect runtime/history before another action.',
    false,
  ],
  [
    'apply',
    'Activate the reviewed saved digest/variables on the exact inspected owner target. May arm automatic triggers. Never substitute a newer target or digest after rejection or lost reply.',
    false,
  ],
  [
    'run',
    'Send explicit data to a manual trigger on the reviewed owner target, with a caller-chosen event UUID. Acceptance returns executionId, not completion. Never generate another event id to recover a lost reply; inspect history.',
    false,
  ],
  [
    'interrupt',
    'Interrupt the exact inspected owner and disarm its triggers. May stop graph-owned agents according to captured cleanup policy. Inspect runtime/history after a failed reply; do not retry automatically.',
    false,
  ],
  [
    'resume',
    'Rearm the exact interrupted owner using its existing activation. This arms automatic triggers; it does not continue arbitrary interrupted scripts or restart an agent. Inspect after failed replies.',
    false,
  ],
  [
    'stop',
    'Stop the exact inspected huddle owner, with its captured agent cleanup policy. Waits for confirmed retirement or fails. Inspect after a failed reply; never retarget a replacement owner.',
    false,
  ],
  [
    'history',
    'Read one bounded page of executions, invocations or operations for the exact owner. Supply after explicitly and parent where required. Does not execute or retry work. Currently requires a connected owner.',
    true,
  ],
  [
    'observe-readout',
    'Request observation of one uncertain readout on its exact owner/activation and operation id. May contact the external integration; does not redeliver. Requires host 28.6 and readout observation support. Acceptance is not success.',
    false,
  ],
] as const;
export const huddleExecutionMcpTools = definitions.map(([action, description, readOnlyHint]) => ({
  name: `huddle_${action.replaceAll('-', '_')}`,
  action,
  description,
  inputSchema: z.toJSONSchema(huddleExecutionToolSchemas[action], {
    io: 'input',
    // Aggregate byte/depth/entry limits are enforced by the original custom
    // validator at dispatch. JSON Schema describes the wire value, not that walk.
    unrepresentable: 'any',
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema === huddleJsonSchema) {
        Object.assign(jsonSchema, {
          type: ['null', 'boolean', 'number', 'string', 'array', 'object'],
          description: `JSON data bounded to ${HUDDLE_LIMITS.valueBytes} UTF-8 bytes, depth ${HUDDLE_LIMITS.valueDepth} and ${HUDDLE_LIMITS.valueEntries} entries; enforced at dispatch.`,
        });
      } else if (zodSchema._zod.def.type === 'custom') {
        throw new Error('Unknown custom validator in huddle MCP schema');
      }
    },
  }),
  annotations: {
    readOnlyHint,
    destructiveHint: !readOnlyHint,
    idempotentHint: readOnlyHint,
    openWorldHint: !readOnlyHint,
  },
}));
