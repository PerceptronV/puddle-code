import { coreHuddleComponents, completionHuddleTrigger } from '@puddle/shared';

/** Captured owner contracts; the public creation catalogue may enable them later. */
export const runtimeHuddleComponents = new Map([
  ...coreHuddleComponents,
  [
    `${completionHuddleTrigger.id}@${completionHuddleTrigger.version}`,
    completionHuddleTrigger,
  ] as const,
]);
