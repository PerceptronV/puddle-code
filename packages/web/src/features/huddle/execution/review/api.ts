import {
  huddleRevisionReviewSchema,
  huddleRetainedRevisionRequestSchema,
  parseHuddleRetainedRevision,
  type HuddleRetainedRevisionRequest,
  huddleDiffReviewSchema,
  parseHuddleReview,
  supportsApplicationFeature,
  type HuddleRevisionReview,
  type HuddleDiffReview,
} from '@puddle/shared';
import { api } from '../../../../lib/transport/api';
import { browserTransport } from '../../../../lib/transport/browser-transport';
import { useDaemonVersion } from '../../../../lib/queries/queries';
import { huddleShellSupported, useHuddleSupported } from '../../documents/queries';

export function useHuddleReviewSupported() {
  const supported = useHuddleSupported();
  const protocol = useDaemonVersion().data?.protocol;
  return supported && supportsApplicationFeature(protocol, { major: 28, minor: 10 });
}

export async function reviewHuddleRevision(
  profile: string,
  session: string,
  input: HuddleRevisionReview | HuddleDiffReview,
  signal?: AbortSignal,
) {
  if (browserTransport() || !huddleShellSupported())
    throw new Error('Huddle revision review requires a supporting local or SSH connection');
  const diff = 'expected_digest' in input;
  const request = (diff ? huddleDiffReviewSchema : huddleRevisionReviewSchema).parse(input);
  return parseHuddleReview(
    request,
    await api(
      'POST',
      `/api/huddle/${profile}/sessions/${session}/${diff ? 'diff' : 'revision'}`,
      request,
      signal,
    ),
  );
}

export function useRetainedRevisionSupported() {
  const supported = useHuddleSupported();
  const protocol = useDaemonVersion().data?.protocol;
  return supported && supportsApplicationFeature(protocol, { major: 28, minor: 13 });
}
export async function reviewRetainedHuddleRevision(
  profile: string,
  session: string,
  input: HuddleRetainedRevisionRequest,
  signal?: AbortSignal,
) {
  if (browserTransport() || !huddleShellSupported())
    throw new Error('Retained revision review requires a supporting local or SSH connection');
  const request = huddleRetainedRevisionRequestSchema.parse(input);
  return parseHuddleRetainedRevision(
    request,
    await api(
      'POST',
      `/api/huddle/${profile}/sessions/${session}/revision/retained`,
      request,
      signal,
    ),
  );
}
