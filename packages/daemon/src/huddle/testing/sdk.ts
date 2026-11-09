import type { PuddlangClient } from '../../puddlang/client.js';
import { fixtureClient } from './api.js';
export { HuddleNode } from '../../puddlang/huddle/node.js';
export { HuddleTrigger } from '../../puddlang/huddle/trigger.js';
export { HuddleReadout } from '../../puddlang/huddle/readout.js';
export { z, default } from 'zod';

export const attach: PuddlangClient['attach'] = (reference) => fixtureClient().attach(reference);
export const spawn: PuddlangClient['spawn'] = (options) => fixtureClient().spawn(options);
