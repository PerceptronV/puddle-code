import {
  huddleSpawnRequestSchema,
  puddlangSpawnSchema,
  type HuddleComponent,
  type HuddleRevisionActivation,
  type PuddlangSpawn,
} from '@puddle/shared';
import { huddleAgentWorktree } from '../bindings.js';

/** A script may choose only resources explicitly retained for this node's activation. */
export function huddleBoundSpawn(
  component: HuddleComponent,
  activation: HuddleRevisionActivation,
  node: string,
  projectId: string,
  raw: PuddlangSpawn,
) {
  const options = puddlangSpawnSchema.parse(raw);
  const worktree = huddleAgentWorktree(component, activation, node);
  if (options.path || options.project !== projectId || options.worktree !== worktree)
    throw new Error(
      'Spawn requires the declared project and exact worktree; path defaults are unavailable',
    );
  const bindings = activation.bindings[node] ?? {};
  const declared = (editor: 'account' | 'project' | 'agent', value: string) => {
    if (
      !Object.entries(component.parameters).some(
        ([name, parameter]) => parameter.editor === editor && bindings[name] === value,
      )
    )
      throw new Error(`Spawn ${editor} must match a declared resource binding`);
  };
  if (options.account === undefined || !/^[1-9][0-9]*$/.test(String(options.account)))
    throw new Error('Spawn requires an explicit resolved account id');
  declared('account', String(options.account));
  declared('agent', options.agent);
  declared('project', projectId);
  return huddleSpawnRequestSchema.parse({
    projectId,
    worktree,
    accountId: Number(options.account),
    agent: options.agent,
    mode: options.mode ?? 'interactive',
    title: options.title ?? component.title,
  });
}
