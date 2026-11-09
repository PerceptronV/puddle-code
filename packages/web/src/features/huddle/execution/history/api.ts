import {
  supportsApplicationFeature,
  huddleHistoryOwnersSchema,
  huddleHistoryOwnersRequestSchema,
  parseHuddleRetainedHistory,
  huddleRetainedHistoryRequestSchema,
  huddleTriggerInputRequestSchema,
  parseHuddleTriggerInput,
  type HuddleTriggerInputRequest,
  type HuddleHistoryOwnersRequest,
  type HuddleRetainedHistoryRequest,
} from '@puddle/shared';
import { api } from '../../../../lib/transport/api';
import { browserTransport } from '../../../../lib/transport/browser-transport';
import { useDaemonVersion } from '../../../../lib/queries/queries';
import { useHuddleSupported } from '../../documents/queries';

export function useRetainedHistorySupported() {
  const supported = useHuddleSupported();
  const version = useDaemonVersion();
  return supported && supportsApplicationFeature(version.data?.protocol, { major: 28, minor: 12 });
}
function path(profile: string, session: string) {
  if (browserTransport()) throw new Error('Huddle history requires a local or SSH connection');
  return `/api/huddle/${profile}/sessions/${session}/history`;
}
export async function huddleHistoryOwners(
  profile: string,
  session: string,
  input: HuddleHistoryOwnersRequest,
  signal?: AbortSignal,
) {
  return huddleHistoryOwnersSchema.parse(
    await api(
      'POST',
      `${path(profile, session)}/owners`,
      huddleHistoryOwnersRequestSchema.parse(input),
      signal,
    ),
  );
}
export async function huddleTriggerInput(
  profile: string,
  session: string,
  input: HuddleTriggerInputRequest,
  signal?: AbortSignal,
) {
  const request = huddleTriggerInputRequestSchema.parse(input);
  return parseHuddleTriggerInput(
    request,
    await api('POST', `${path(profile, session)}/input`, request, signal),
  );
}
export async function huddleRetainedHistory(
  profile: string,
  session: string,
  input: HuddleRetainedHistoryRequest,
  signal?: AbortSignal,
) {
  const request = huddleRetainedHistoryRequestSchema.parse(input);
  return parseHuddleRetainedHistory(
    request,
    await api('POST', `${path(profile, session)}/retained`, request, signal),
  );
}
