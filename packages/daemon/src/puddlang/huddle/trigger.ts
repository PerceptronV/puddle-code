import { huddleRelativePathSchema } from '@puddle/shared';
import type { HuddleTriggerAdapter } from './context.js';

/** Declaration only. Opening/inspection never evaluates project source. */
export function HuddleTrigger(adapter: HuddleTriggerAdapter): Readonly<HuddleTriggerAdapter> {
  const contract = huddleRelativePathSchema.parse(adapter.contract);
  if (typeof adapter.open !== 'function') throw new Error('HuddleTrigger needs an open function');
  return Object.freeze({ contract, open: adapter.open });
}
