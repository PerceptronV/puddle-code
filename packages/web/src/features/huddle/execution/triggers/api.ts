import {
  huddleLifecycleCommandSchema,
  parseHuddleTriggerReport,
  type HuddleCommandTarget,
} from '@puddle/shared';
import { api } from '../../../../lib/transport/api';
import { browserTransport } from '../../../../lib/transport/browser-transport';
import { huddleShellSupported } from '../../documents/queries';

export async function inspectTriggers(
  profile: string,
  session: string,
  target: HuddleCommandTarget,
  signal?: AbortSignal,
) {
  if (browserTransport() || !huddleShellSupported())
    throw new Error('Trigger inspection requires a supporting local or SSH connection');
  const input = huddleLifecycleCommandSchema.parse({ target });
  return parseHuddleTriggerReport(
    input.target,
    await api('POST', `/api/huddle/${profile}/sessions/${session}/triggers`, input, signal),
  );
}
