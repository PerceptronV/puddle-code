import {
  huddleRevisionReviewSchema,
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
