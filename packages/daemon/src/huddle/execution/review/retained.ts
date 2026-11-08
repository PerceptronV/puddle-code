import {
  huddleRetainedRevisionSchema,
  type HuddleRetainedRevisionRequest,
  type Session,
} from '@puddle/shared';
import type { RuntimeBinding } from '../../../db/stores/runtimes.js';
import type { HuddleDefinitionSnapshot } from '../../definitions/capture.js';
import { ApiError } from '../../../http/errors.js';
import { readRecordedHuddleActivation } from '../../../runtime/huddle/state/readers/activation.js';
import { readRetainedHuddleRevision } from '../../../runtime/huddle/state/revisions.js';
import { retainedHuddleLaunch } from '../retained/identity.js';
import { compareHuddleRevisions } from './compare.js';

/** Captured recorded source stays fixed while optional saved-source capture runs. */
export function retainedHuddleReview({
  home,
  profile,
  session,
  binding,
  input,
}: {
  home: string;
  profile: string;
  session: Session;
  binding(): RuntimeBinding | null;
  input: HuddleRetainedRevisionRequest;
}) {
  let active: HuddleDefinitionSnapshot;
  let activation: ReturnType<typeof readRecordedHuddleActivation> | null = null;
  try {
    const launch = retainedHuddleLaunch(home, profile, session, binding(), input);
    if (!input.revision)
      activation = readRecordedHuddleActivation(home, launch.scope, session.worktree_path);
    active = readRetainedHuddleRevision(
      home,
      input.owner.runtimeId,
      session.huddle_id!,
      input.revision ?? activation!.revision,
    );
  } catch {
    throw ApiError.conflict(
      'huddle_revision_unavailable',
      'Retained revision is unavailable, unsupported or changed during inspection; no owner was started',
    );
  }
  const observed_at = new Date().toISOString();
  const finish = (saved?: HuddleDefinitionSnapshot) => {
    if (saved && saved.digest !== input.expected_digest)
      throw ApiError.conflict(
        'huddle_source_changed',
        'Saved source changed; inspect its digest before comparing again',
      );
    let comparison: ReturnType<typeof compareHuddleRevisions>;
    try {
      comparison = compareHuddleRevisions(active, saved, input.entry);
    } catch {
      throw ApiError.badRequest(
        'huddle_review_entry_missing',
        'Choose an entry in the reviewed source closure',
      );
    }
    // Async saved capture must not substitute a changed placement or private launch.
    retainedHuddleLaunch(home, profile, session, binding(), input);
    return huddleRetainedRevisionSchema.parse({
      source: 'retained-revision',
      observed_at,
      owner: input.owner,
      revision: active.digest,
      activation: activation
        ? {
            id: activation.id,
            revision: activation.revision,
            worktree: activation.worktree,
            variables: activation.variables,
            bindings: activation.bindings,
            appliedAt: activation.appliedAt,
          }
        : null,
      saved: saved ? { digest: saved.digest, diagnostics: saved.diagnostics } : null,
      ...comparison,
    });
  };
  return { finish };
}
