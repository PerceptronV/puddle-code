import { realpathSync } from 'node:fs';
import {
  HUDDLE_COMPLETION_SOURCE_LIMIT,
  completionHuddleTrigger,
  huddleCompletionSettingsSchema,
  resolveHuddleParameters,
  type HuddleRevisionActivation,
} from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from '../../../../huddle/definitions/capture.js';

export function completionDefinitions(
  snapshot: HuddleDefinitionSnapshot,
  activation: HuddleRevisionActivation,
) {
  const nodes = snapshot.definition.nodes.filter(
    (node) =>
      node.source.kind === 'builtin' && node.source.component === completionHuddleTrigger.id,
  );
  if (nodes.length > HUDDLE_COMPLETION_SOURCE_LIMIT)
    throw new Error('A huddle supports at most 8 completion triggers');
  return nodes.map((node, slot) => {
    const settings = huddleCompletionSettingsSchema.parse(
      resolveHuddleParameters(
        snapshot.definition,
        node,
        snapshot.components[node.id]!,
        activation.variables,
      ),
    );
    const bound = activation.bindings[node.id];
    if (
      !bound?.worktree ||
      realpathSync(settings.worktree) !== bound.worktree ||
      bound.session !== settings.session
    )
      throw new Error('Completion trigger requires exact resolved session/worktree bindings');
    return { ...settings, node: node.id, slot, worktree: bound.worktree };
  });
}
export type CompletionDefinition = ReturnType<typeof completionDefinitions>[number];
