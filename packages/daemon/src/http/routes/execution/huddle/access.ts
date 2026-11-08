import type { MiddlewareHandler } from 'hono';
import { ApiError } from '../../../errors.js';

/** A direct daemon request cannot bypass the connector's huddle exclusion. */
export const localHuddleAccess: MiddlewareHandler = async (c, next) => {
  if (c.get('remoteProfile'))
    throw new ApiError(403, 'profile_scope', 'Huddles currently require local or SSH access');
  await next();
};
