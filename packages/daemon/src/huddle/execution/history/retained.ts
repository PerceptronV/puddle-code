import { retainedHuddleLaunch } from '../retained/identity.js';
import type { Session, HuddleRetainedHistoryRequest } from '@puddle/shared';
import type { RuntimeBinding } from '../../../db/stores/runtimes.js';
import { ApiError } from '../../../http/errors.js';
import { readRetainedHuddleHistory as readPage } from '../../../runtime/huddle/state/readers/history.js';
import { projectHuddleHistory } from './projection.js';

export function readRetainedHuddleHistory(
  home: string,
  profile: string,
  session: Session,
  binding: RuntimeBinding | null,
  input: HuddleRetainedHistoryRequest,
) {
  try {
    const launch = retainedHuddleLaunch(home, profile, session, binding, input);
    const { owner, include_readout_observation, ...query } = input;
    const page = readPage(home, launch.scope, query);
    return {
      source: 'retained-ledger' as const,
      observed_at: new Date().toISOString(),
      history: projectHuddleHistory(
        { ...page, owner },
        include_readout_observation &&
          binding?.state === 'exited' &&
          launch.capabilities.readoutObservation === 1,
      ),
    };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'huddle_history_changed') throw error;
    throw ApiError.conflict(
      'huddle_history_unavailable',
      'Retained history is unavailable, unsupported or changed during inspection; no owner was started',
    );
  }
}
