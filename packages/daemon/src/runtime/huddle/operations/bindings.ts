import { isAbsolute } from 'node:path';
import {
  canonicalHuddleJson,
  decodeHuddleAgentTarget,
  type HuddleAgentTarget,
  type HuddleComponent,
  type HuddleRevisionActivation,
} from '@puddle/shared';

/** Only the invocation's retained resource bindings can name an agent; worker handles are not authority. */
export function huddleBoundAgent(
  component: HuddleComponent,
  activation: HuddleRevisionActivation,
  node: string,
  reference: string | { runtime_id: string; session_id: string },
): HuddleAgentTarget {
  if (!component.capabilities.includes('sessions'))
    throw new Error('Node did not declare session operations');
  const bindings = activation.bindings[node] ?? {};
  if (
    component.parameters.worktree?.editor !== 'worktree' ||
    !bindings.worktree ||
    !isAbsolute(bindings.worktree)
  )
    throw new Error('Agent operations require a declared absolute worktree binding');
  const matches = new Map<string, HuddleAgentTarget>();
  for (const [name, parameter] of Object.entries(component.parameters)) {
    if (parameter.editor !== 'session' || !bindings[name]) continue;
    const target = decodeHuddleAgentTarget(bindings[name]);
    if (target.worktree !== bindings.worktree)
      throw new Error('Agent binding differs from the declared worktree');
    const selected =
      typeof reference === 'string'
        ? reference === bindings[name] ||
          reference === target.sessionId ||
          reference === target.runtimeId
        : reference.runtime_id === target.runtimeId && reference.session_id === target.sessionId;
    if (selected) matches.set(canonicalHuddleJson(target), target);
  }
  if (matches.size !== 1)
    throw new Error('Choose exactly one declared agent binding for this node');
  return [...matches.values()][0]!;
}
