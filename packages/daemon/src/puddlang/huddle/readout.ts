import { huddleRelativePathSchema } from '@puddle/shared';
import type { HuddleReadoutAdapter } from './context.js';

/** Declaration only; delivery policy lives in the captured component manifest. */
export function HuddleReadout(adapter: HuddleReadoutAdapter): Readonly<HuddleReadoutAdapter> {
  const contract = huddleRelativePathSchema.parse(adapter.contract);
  if (typeof adapter.deliver !== 'function')
    throw new Error('HuddleReadout needs a deliver function');
  if (adapter.observe !== undefined && typeof adapter.observe !== 'function')
    throw new Error('HuddleReadout observe must be a function');
  return Object.freeze({
    contract,
    deliver: adapter.deliver,
    ...(adapter.observe ? { observe: adapter.observe } : {}),
  });
}
