import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  filetreeHuddleTrigger,
  huddleHostTrigger,
  resolveHuddleHostParameters,
  HUDDLE_FILETREE_LIMITS,
  huddleFiletreeSettingsSchema,
  type HuddleRevisionActivation,
  type HuddleFiletreeSettings,
} from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from '../../../../huddle/definitions/capture.js';

export function requireFiletreeRoot(settings: HuddleFiletreeSettings) {
  const parts = settings.directory.split('/');
  if (
    parts.includes('.git') ||
    parts.some((part, index) => part === '.puddle' && parts[index + 1] === 'huddle') ||
    settings.outputPaths.some(
      (path) => settings.directory === path || settings.directory.startsWith(`${path}/`),
    )
  )
    throw new Error('Filetree directory is excluded Git, huddle or declared output storage');
  if (!isAbsolute(settings.worktree) || realpathSync(settings.worktree) !== settings.worktree)
    throw new Error('Filetree worktree must retain its explicit canonical root');
  let path = settings.worktree;
  for (const part of settings.directory === '.' ? [] : settings.directory.split('/')) {
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink())
      throw new Error('Filetree directory cannot follow a symlink');
  }
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== path)
    throw new Error('Filetree directory is unavailable or moved');
  return path;
}
export function filetreeDefinitions(
  snapshot: HuddleDefinitionSnapshot,
  activation: HuddleRevisionActivation,
) {
  const nodes = snapshot.definition.nodes.filter(
    (node) =>
      huddleHostTrigger(node, snapshot.components[node.id])?.id === filetreeHuddleTrigger.id,
  );
  if (nodes.length > HUDDLE_FILETREE_LIMITS.sources)
    throw new Error('A huddle supports at most 8 Filetree triggers');
  return nodes.map((node, slot) => {
    const settings = huddleFiletreeSettingsSchema.parse(
      resolveHuddleHostParameters(
        snapshot.definition,
        node,
        snapshot.components[node.id]!,
        activation.variables,
      ),
    );
    const worktree = activation.bindings[node.id]?.worktree;
    if (!worktree || realpathSync(settings.worktree) !== worktree)
      throw new Error('Filetree requires an exact resolved worktree binding');
    const definition = { ...settings, worktree, node: node.id, slot };
    requireFiletreeRoot(definition);
    return definition;
  });
}
export type FiletreeDefinition = ReturnType<typeof filetreeDefinitions>[number];
