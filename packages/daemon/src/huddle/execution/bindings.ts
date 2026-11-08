import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
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
) {
  resolveHuddleVariables(snapshot.definition, variables);
  const bindings: HuddleRevisionActivation['bindings'] = {};
  const unsupported = (message: string): never => {
    throw ApiError.conflict('huddle_execution_unsupported', message);
  };
  if (snapshot.definition.execution.queue !== 'queue')
    unsupported('This runtime supports queued manual inputs only');
  for (const node of snapshot.definition.nodes) {
    const component = snapshot.components[node.id]!;
    if (node.source.kind === 'local' && component.category !== 'script')
      unsupported('Custom trigger and readout adapters are not available yet');
    if (component.capabilities.includes('sessions'))
      unsupported('The huddle agent-operation bridge is not available yet');
    const values = resolveHuddleParameters(snapshot.definition, node, component, variables);
    const resolved: Record<string, string> = {};
    for (const [name, parameter] of Object.entries(component.parameters)) {
      const value = values[name];
      if (value === undefined) continue;
      if (['account', 'session', 'project', 'agent'].includes(parameter.editor))
        unsupported('Account, agent, project and session resource bindings are not available yet');
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
    if (Object.keys(resolved).length) bindings[node.id] = resolved;
  }
  return bindings;
}
