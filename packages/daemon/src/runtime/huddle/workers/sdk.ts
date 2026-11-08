import { workerPuddlang } from './calls.js';
import type { PuddlangSpawn } from '@puddle/shared';
export { HuddleNode } from '../../../puddlang/huddle/node.js';
export type { HuddleNodeContext, HuddleValues } from '../../../puddlang/huddle/context.js';
export { z, default } from 'zod';
export const spawn = (options: PuddlangSpawn) => workerPuddlang().spawn(options);
export const attach = (reference: string) => workerPuddlang().attach(reference);
