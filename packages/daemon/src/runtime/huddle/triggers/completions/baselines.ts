import {
  HUDDLE_COMPLETION_SOURCE_LIMIT,
  huddleCompletionBaselinesSchema,
  huddleCompletionSettingsSchema,
  type HuddleCompletionBaseline,
  type HuddleLedgerIdentity,
  type HuddleRevisionActivation,
} from '@puddle/shared';
import type { CompletionDefinition } from './definitions.js';

/** Run before lifecycle intent changes, and again at durable source admission. */
export function validateCompletionBaselines(
  definitions: CompletionDefinition[],
  activation: HuddleRevisionActivation,
  input: HuddleCompletionBaseline[] | undefined,
  identity: HuddleLedgerIdentity,
) {
  const baselines = huddleCompletionBaselinesSchema.parse(input ?? []);
  if (
    definitions.length > HUDDLE_COMPLETION_SOURCE_LIMIT ||
    definitions.length !== baselines.length ||
    new Set(definitions.map((definition) => definition.node)).size !== definitions.length
  )
    throw new Error('Completion subscriptions require one exact baseline per node');
  return definitions.map((definition, slot) => {
    huddleCompletionSettingsSchema.parse({
      worktree: definition.worktree,
      session: definition.session,
    });
    const baseline = baselines.find((item) => item.node === definition.node);
    const binding = activation.bindings[definition.node];
    if (
      slot !== definition.slot ||
      !baseline ||
      binding?.worktree !== definition.worktree ||
      binding.session !== definition.session ||
      baseline.target.sessionId !== definition.session ||
      baseline.target.sessionId === identity.sessionId ||
      baseline.target.identity.runtime_id === identity.runtimeId ||
      baseline.target.identity.profile_id !== identity.profileId ||
      baseline.target.identity.project_id !== identity.projectId ||
      baseline.target.identity.canonical_worktree_path !== definition.worktree
    )
      throw new Error('Completion baseline differs from its declared owner/session/worktree scope');
    return { ...baseline, slot };
  });
}
