import {
  huddleApplySchema,
  huddleRecoverSchema,
  type HuddleRecover,
  huddleReadoutObserveSchema,
  huddleReadoutObserveAcceptedSchema,
  type HuddleReadoutObserve,
  huddleLifecycleCommandSchema,
  huddleRunSchema,
  huddleStartSchema,
  huddleHistoryPageSchema,
  huddleHistoryRequestSchema,
  huddleRunAcceptedSchema,
  huddleRuntimeInspectionSchema,
  huddleStoppedSchema,
  type HuddleApply,
  type HuddleLifecycleCommand,
  type HuddleRun,
  type HuddleStart,
  type HuddleHistoryRequest,
} from '@puddle/shared';
import { api } from '../../../lib/transport/api';
import { browserTransport } from '../../../lib/transport/browser-transport';
import { huddleShellSupported } from '../documents/queries';

export type HuddleCommand =
  | { action: 'recover'; input: HuddleRecover }
  | { action: 'readouts/observe'; input: HuddleReadoutObserve }
  | { action: 'start'; input: HuddleStart }
  | { action: 'apply'; input: HuddleApply }
  | { action: 'run'; input: HuddleRun }
  | { action: 'rearm' | 'interrupt' | 'stop'; input: HuddleLifecycleCommand };
const path = (profile: string, session: string) => `/api/huddle/${profile}/sessions/${session}`;
function local() {
  if (browserTransport() || !huddleShellSupported())
    throw new Error('Huddle execution requires a supporting local or SSH connection');
}
export async function inspectHuddle(
  profile: string,
  session: string,
  signal?: AbortSignal,
  includeReadoutObservation = false,
  includeCustomTriggers = false,
  includeRecovery = false,
) {
  local();
  const query = new URLSearchParams();
  if (includeReadoutObservation) query.set('include_readout_observation', 'true');
  if (includeCustomTriggers) query.set('include_custom_triggers', 'true');
  if (includeRecovery) query.set('include_recovery', 'true');
  return huddleRuntimeInspectionSchema.parse(
    await api(
      'GET',
      `${path(profile, session)}/runtime${query.size ? '?' + query.toString() : ''}`,
      undefined,
      signal,
    ),
  );
}
export async function huddleHistory(
  profile: string,
  session: string,
  input: HuddleHistoryRequest,
  signal?: AbortSignal,
) {
  local();
  return huddleHistoryPageSchema.parse(
    await api(
      'POST',
      `${path(profile, session)}/history`,
      huddleHistoryRequestSchema.parse(input),
      signal,
    ),
  );
}
export async function sendHuddleCommand(profile: string, session: string, command: HuddleCommand) {
  local();
  const schemas = {
    recover: huddleRecoverSchema,
    'readouts/observe': huddleReadoutObserveSchema,
    start: huddleStartSchema,
    apply: huddleApplySchema,
    run: huddleRunSchema,
    rearm: huddleLifecycleCommandSchema,
    interrupt: huddleLifecycleCommandSchema,
    stop: huddleLifecycleCommandSchema,
  };
  const input = schemas[command.action].parse(command.input);
  const reply = await api('POST', `${path(profile, session)}/${command.action}`, input);
  if (command.action === 'readouts/observe')
    return { action: 'observing' as const, value: huddleReadoutObserveAcceptedSchema.parse(reply) };
  if (command.action === 'run')
    return { action: 'run' as const, value: huddleRunAcceptedSchema.parse(reply) };
  if (command.action === 'stop')
    return { action: 'stop' as const, value: huddleStoppedSchema.parse(reply) };
  return { action: 'state' as const, value: huddleRuntimeInspectionSchema.parse(reply) };
}
