import {
  huddleTriggerInputSchema,
  type HuddleTriggerInputRequest,
  type Session,
} from '@puddle/shared';
import type { RuntimeBinding } from '../../../db/stores/runtimes.js';
import { retainedHuddleLaunch } from '../retained/identity.js';
import { readHuddleTriggerInput } from '../../../runtime/huddle/state/readers/trigger-input.js';
import { ApiError } from '../../../http/errors.js';

export function retainedTriggerInput(
  home: string,
  profile: string,
  session: Session,
  binding: RuntimeBinding | null,
  input: HuddleTriggerInputRequest,
) {
  const launch = retainedHuddleLaunch(home, profile, session, binding, input);
  try {
    const ancestors = launch.recovery
      ? [launch.recovery.source, ...launch.recovery.ancestors].map(
          (identity) => identity.runtime_id,
        )
      : [];
    const event = readHuddleTriggerInput(home, launch.scope, input.execution_id, ancestors);
    return huddleTriggerInputSchema.parse({
      source: 'retained-trigger',
      observed_at: new Date().toISOString(),
      owner: input.owner,
      event: huddleTriggerInputSchema.shape.event.strip().parse(event),
    });
  } catch {
    throw ApiError.conflict(
      'huddle_input_unavailable',
      'Recorded trigger input is unavailable, unsupported or changed during inspection; no owner was started',
    );
  }
}
