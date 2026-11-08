import { isAbsolute } from 'node:path';
import {
  canonicalHuddleJson,
  decodeHuddleAgentTarget,
  encodeHuddleAgentTarget,
  type HuddleAgentTarget,
  type HuddleComponent,
  type HuddleRevisionActivation,
} from '@puddle/shared';

export function huddleAgentWorktree(
  component: HuddleComponent,
  activation: HuddleRevisionActivation,
  node: string,
) {
  if (!component.capabilities.includes('sessions'))
    throw new Error('Node did not declare session operations');
  const bindings = activation.bindings[node] ?? {};
  if (
    component.parameters.worktree?.editor !== 'worktree' ||
    !bindings.worktree ||
    !isAbsolute(bindings.worktree)
  )
    throw new Error('Agent operations require a declared absolute worktree binding');
  return bindings.worktree;
}

/** Only retained resource bindings or this execution’s spawn/lifecycle results can name an agent. */
export function huddleBoundAgent(
  component: HuddleComponent,
  activation: HuddleRevisionActivation,
  node: string,
  reference: string | { runtime_id: string; session_id: string },
  owned?: HuddleAgentTarget | null,
): HuddleAgentTarget {
  const worktree = huddleAgentWorktree(component, activation, node);
  const bindings = activation.bindings[node] ?? {};
  const matches = new Map<string, HuddleAgentTarget>();
  for (const [name, parameter] of Object.entries(component.parameters)) {
    if (component.lifecycle || parameter.editor !== 'session' || !bindings[name]) continue;
    const target = decodeHuddleAgentTarget(bindings[name]);
    if (target.worktree !== worktree)
      throw new Error('Agent binding differs from the declared worktree');
    const selected =
      typeof reference === 'string'
        ? reference === bindings[name] ||
          reference === target.sessionId ||
          reference === target.runtimeId
        : reference.runtime_id === target.runtimeId && reference.session_id === target.sessionId;
    if (selected) matches.set(canonicalHuddleJson(target), target);
  }
  if (owned) {
    if (owned.worktree !== worktree)
      throw new Error('Recorded agent differs from the declared worktree');
    const selected =
      typeof reference === 'string'
        ? reference === owned.runtimeId ||
          reference === owned.sessionId ||
          reference === encodeHuddleAgentTarget(owned)
        : reference.runtime_id === owned.runtimeId && reference.session_id === owned.sessionId;
    if (!selected) throw new Error('Recorded agent differs from the requested handle');
    matches.set(canonicalHuddleJson(owned), owned);
  }
  if (matches.size !== 1)
    throw new Error('Choose exactly one declared agent binding for this node');
  return [...matches.values()][0]!;
}
