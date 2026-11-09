import { realpathSync } from 'node:fs';
import {
  HUDDLE_SESSION_SOURCE_LIMIT,
  sessionHuddleTrigger,
  huddleHostTrigger,
  resolveHuddleHostParameters,
  huddleSessionSettingsSchema,
  type HuddleRevisionActivation,
  type HuddleSessionFeedCursor,
} from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from '../../../../huddle/definitions/capture.js';

export function requireSessionBaseline(
  snapshot: HuddleDefinitionSnapshot,
  baseline?: HuddleSessionFeedCursor,
) {
  if (
    !baseline &&
    snapshot.definition.nodes.some(
      (node) =>
        huddleHostTrigger(node, snapshot.components[node.id])?.id === sessionHuddleTrigger.id,
    )
  )
    throw new Error('Session triggers require a current host feed baseline before arming');
}
export function sessionDefinitions(
  snapshot: HuddleDefinitionSnapshot,
  activation: HuddleRevisionActivation,
) {
  const nodes = snapshot.definition.nodes.filter(
    (node) => huddleHostTrigger(node, snapshot.components[node.id])?.id === sessionHuddleTrigger.id,
  );
  if (nodes.length > HUDDLE_SESSION_SOURCE_LIMIT)
    throw new Error('A huddle supports at most 8 session triggers');
  return nodes.map((node, slot) => {
    const settings = huddleSessionSettingsSchema.parse(
      resolveHuddleHostParameters(
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
      (settings.session !== undefined && bound.session !== settings.session)
    )
      throw new Error('Session trigger requires exact resolved session/worktree bindings');
    return { ...settings, worktree: bound.worktree, node: node.id, slot };
  });
}
export type SessionDefinition = ReturnType<typeof sessionDefinitions>[number];
