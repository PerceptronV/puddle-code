import { workerPuddlang } from './calls.js';
import type { PuddlangSpawn } from '@puddle/shared';
export { HuddleNode } from '../../../puddlang/huddle/node.js';
export { HuddleReadout } from '../../../puddlang/huddle/readout.js';
export { HuddleTrigger } from '../../../puddlang/huddle/trigger.js';
export type {
  HuddleReadoutAdapter,
  HuddleExtensionContext,
  HuddleTriggerAdapter,
  HuddleTriggerContext,
} from '../../../puddlang/huddle/context.js';
export type { HuddleDelivery, HuddleDeliveryResult } from '@puddle/shared';
export type { HuddleNodeContext, HuddleValues } from '../../../puddlang/huddle/context.js';
export { z, default } from 'zod';
export const spawn = (options: PuddlangSpawn) => workerPuddlang().spawn(options);
export const attach = (reference: string) => workerPuddlang().attach(reference);
