import { z } from 'zod';
import { sessionId } from '../../common.js';
import { huddleJsonSchema, HUDDLE_LIMITS } from '../values.js';
import { huddleRevisionReviewSchema, huddleDiffReviewSchema } from '../review.js';
import {
  huddleStartSchema,
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
  revision: z.strictObject({ ...session, request: huddleRevisionReviewSchema }),
  diff: z.strictObject({ ...session, request: huddleDiffReviewSchema }),
  start: z.strictObject({ ...session, request: huddleStartSchema }),
  apply: z.strictObject({ ...session, request: huddleApplySchema }),
  run: z.strictObject({ ...session, request: huddleRunSchema }),
  interrupt: z.strictObject({ ...session, request: huddleLifecycleCommandSchema }),
  resume: z.strictObject({ ...session, request: huddleLifecycleCommandSchema }),
  stop: z.strictObject({ ...session, request: huddleLifecycleCommandSchema }),
  history: z.strictObject({ ...session, request: huddleHistoryRequestSchema }),
  'observe-readout': z.strictObject({ ...session, request: huddleReadoutObserveSchema }),
};
export const huddleToolExecutionCommandSchema = z.discriminatedUnion('action', [
  huddleExecutionToolSchemas.runtime.extend({ action: z.literal('runtime') }),
  huddleExecutionToolSchemas.revision.extend({ action: z.literal('revision') }),
  huddleExecutionToolSchemas.diff.extend({ action: z.literal('diff') }),
  huddleExecutionToolSchemas.start.extend({ action: z.literal('start') }),
  huddleExecutionToolSchemas.apply.extend({ action: z.literal('apply') }),
  huddleExecutionToolSchemas.run.extend({ action: z.literal('run') }),
  huddleExecutionToolSchemas.interrupt.extend({ action: z.literal('interrupt') }),
  huddleExecutionToolSchemas.resume.extend({ action: z.literal('resume') }),
  huddleExecutionToolSchemas.stop.extend({ action: z.literal('stop') }),
  huddleExecutionToolSchemas.history.extend({ action: z.literal('history') }),
  huddleExecutionToolSchemas['observe-readout'].extend({ action: z.literal('observe-readout') }),
]);
export type HuddleToolExecutionCommand = z.infer<typeof huddleToolExecutionCommandSchema>;

const definitions = [
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
