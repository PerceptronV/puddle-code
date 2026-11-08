import { requireHuddleDefinitionLocation } from '../definitions/location.js';
import type { Session } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';

/** Retained code remains inspectable, but missing source cannot admit new work. */
export function requireHuddleSource(session: Session) {
  try {
    requireHuddleDefinitionLocation(session.worktree_path, session.huddle_id!);
  } catch {
    throw ApiError.conflict(
      'huddle_source_unavailable',
      'Restore the huddle source before admitting new work; inspection and Stop remain available',
    );
  }
}
