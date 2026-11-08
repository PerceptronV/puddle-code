import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  sessionHuddleTrigger,
  completionHuddleTrigger,
  resolveHuddleParameters,
  resolveHuddleVariables,
  type HuddleStart,
  type HuddleRevisionActivation,
} from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from '../definitions/capture.js';
import { ApiError } from '../../http/errors.js';

/** Validate current execution support before owner intent; bridge-backed resources follow separately. */
export function huddleExecutionBindings(
  snapshot: HuddleDefinitionSnapshot,
  variables: HuddleStart['variables'],
  worktrees: string[],
  agent?: (reference: string, worktree: string) => string,
  observeSession?: (reference: string, worktree: string, kind: 'any' | 'agent') => string,
) {
  resolveHuddleVariables(snapshot.definition, variables);
  const bindings: HuddleRevisionActivation['bindings'] = {};
  const unsupported = (message: string): never => {
    throw ApiError.conflict('huddle_execution_unsupported', message);
  };
  if (snapshot.definition.execution.queue !== 'queue')
    unsupported('This runtime supports queued trigger inputs only');
  for (const node of snapshot.definition.nodes) {
    const component = snapshot.components[node.id]!;
    const completion =
      node.source.kind === 'builtin' && component.id === completionHuddleTrigger.id;
    const observing =
      completion || (node.source.kind === 'builtin' && component.id === sessionHuddleTrigger.id);
    const resolveSession = observing
      ? observeSession &&
        ((reference: string, worktree: string) =>
          observeSession(reference, worktree, completion ? 'agent' : 'any'))
      : agent;
    if (node.source.kind === 'local' && component.category !== 'script')
      unsupported('Custom trigger and readout adapters are not available yet');
    if (component.capabilities.includes('sessions') && !observing && !agent)
      unsupported('The huddle agent-operation bridge is not available yet');
    const values = resolveHuddleParameters(snapshot.definition, node, component, variables);
    const resolved: Record<string, string> = {};
    for (const [name, parameter] of Object.entries(component.parameters)) {
      const value = values[name];
      if (value === undefined) continue;
      if (['account', 'project', 'agent'].includes(parameter.editor))
        unsupported('Account, agent and project resource bindings are not available yet');
      if (parameter.editor !== 'worktree') continue;
      if (typeof value !== 'string' || !isAbsolute(value))
        throw ApiError.badRequest(
          'invalid_worktree',
          'Node worktrees must be explicit registered absolute roots',
        );
      const canonical = realpathSync(value);
      if (!worktrees.includes(canonical))
        throw ApiError.badRequest(
          'unknown_worktree',
          'Node worktree is not registered to this project',
        );
      resolved[name] = canonical;
    }
    for (const [name, parameter] of Object.entries(component.parameters)) {
      if (parameter.editor !== 'session' || values[name] === undefined) continue;
      if (!resolveSession || !component.capabilities.includes('sessions') || !resolved.worktree)
        unsupported('Session bindings require a supported resolver and an explicit worktree');
      if (typeof values[name] !== 'string')
        throw ApiError.badRequest('invalid_session', 'Choose a session id');
      resolved[name] = resolveSession!(values[name] as string, resolved.worktree!);
    }
    if (Object.keys(resolved).length) bindings[node.id] = resolved;
  }
  return bindings;
}
