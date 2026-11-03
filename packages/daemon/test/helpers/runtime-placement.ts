import type { RuntimePlacement } from '@puddle/shared';
import type { RuntimeClient } from '../../src/runtime/client.js';

/** Tests capture the explicit placement address; the production client never fills it in. */
export function placement(client: RuntimeClient): RuntimePlacement {
  const binding = client.state?.binding;
  if (!binding) throw new Error('Runtime has no acknowledged placement');
  return { segment_id: binding.segment_id, session_id: binding.session_id };
}
