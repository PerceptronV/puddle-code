import { huddleRelativePathSchema } from '@puddle/shared';
import type { HuddleNodeContext, HuddleValues } from './context.js';

export interface HuddleNodeModule {
  contract: string;
  run(context: HuddleNodeContext): Promise<HuddleValues> | HuddleValues;
}

/** A declaration only. The worker supplies the captured contract and scoped operation bridge. */
export function HuddleNode(node: HuddleNodeModule): Readonly<HuddleNodeModule> {
  const contract = huddleRelativePathSchema.parse(node.contract);
  if (typeof node.run !== 'function') throw new Error('HuddleNode needs a run function');
  return Object.freeze({ contract, run: node.run });
}
