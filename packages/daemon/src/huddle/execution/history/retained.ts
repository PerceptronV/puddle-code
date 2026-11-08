import { join } from 'node:path';
import type { Session, HuddleRetainedHistoryRequest } from '@puddle/shared';
import type { RuntimeBinding } from '../../../db/stores/runtimes.js';
import { ApiError } from '../../../http/errors.js';
import { readRuntimeJson } from '../../../runtime/ownership/storage.js';
import { requireHuddleBindingLaunch } from '../../../runtime/huddle/ownership/binding.js';
import { retainedHuddleDirectory } from '../../../runtime/huddle/state/readers/database.js';
import { readRetainedHuddleHistory as readPage } from '../../../runtime/huddle/state/readers/history.js';
import { projectHuddleHistory } from './projection.js';

export function readRetainedHuddleHistory(
  home: string,
  profile: string,
  session: Session,
  binding: RuntimeBinding | null,
  input: HuddleRetainedHistoryRequest,
) {
  if (
    !binding ||
    binding.role !== 'huddle' ||
    binding.runtime_id !== input.owner.runtimeId ||
    binding.incarnation !== input.owner.incarnation ||
    binding.profile_id !== profile ||
    binding.project_id !== session.project_id ||
    binding.huddle_id !== session.huddle_id ||
    binding.launch_session_id !== session.id ||
    binding.active_session_id !== session.id ||
    binding.canonical_worktree_path !== session.worktree_path
  )
    throw ApiError.conflict(
      'huddle_history_changed',
      'Recorded huddle owner does not match this placement',
    );
  try {
    const directory = retainedHuddleDirectory(home, binding.runtime_id);
    const launch = requireHuddleBindingLaunch(
      binding,
      readRuntimeJson(join(directory, 'launch.json')),
    );
    if (launch.capabilities.ledger !== 1) throw new Error('Unsupported ledger');
    const { owner, ...query } = input;
    const page = readPage(home, launch.scope, query);
    return {
      source: 'retained-ledger' as const,
      observed_at: new Date().toISOString(),
      history: projectHuddleHistory({ ...page, owner }),
    };
  } catch {
    throw ApiError.conflict(
      'huddle_history_unavailable',
      'Retained history is unavailable, unsupported or changed during inspection; no owner was started',
    );
  }
}
