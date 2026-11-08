import { realpathSync } from 'node:fs';
import {
  gitHuddleTrigger,
  huddleGitSettingsSchema,
  HUDDLE_GIT_LIMITS,
  resolveHuddleParameters,
  type HuddleRevisionActivation,
} from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from '../../../../huddle/definitions/capture.js';
import { requireTriggerDirectory } from '../worktree.js';

export function gitDefinitions(
  snapshot: HuddleDefinitionSnapshot,
  activation: HuddleRevisionActivation,
) {
  const nodes = snapshot.definition.nodes.filter(
    (node) => node.source.kind === 'builtin' && node.source.component === gitHuddleTrigger.id,
  );
  if (nodes.length > HUDDLE_GIT_LIMITS.sources)
    throw new Error('A huddle supports at most 8 Git triggers');
  return nodes.map((node, slot) => {
    const settings = huddleGitSettingsSchema.parse(
      resolveHuddleParameters(
        snapshot.definition,
        node,
        snapshot.components[node.id]!,
        activation.variables,
      ),
    );
    const worktree = activation.bindings[node.id]?.worktree;
    if (!worktree || realpathSync(settings.worktree) !== worktree)
      throw new Error('Git trigger requires an exact resolved worktree binding');
    const repository = requireTriggerDirectory(worktree, settings.repository);
    return { ...settings, worktree, repository, node: node.id, slot };
  });
}
export type GitDefinition = ReturnType<typeof gitDefinitions>[number];
