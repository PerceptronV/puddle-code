import { canonicalHuddleJson, type HuddleAgentOperation } from '@puddle/shared';
import type { RuntimeBinding } from '../../../db/stores/runtimes.js';
import type { HuddleOwnerClient } from '../../../runtime/huddle/transport/client.js';
import { HuddleRevisionStore } from '../../../runtime/huddle/state/revisions.js';
import { runtimeBindingIdentity } from '../../../runtime/transport/connections.js';

/** Only the authenticated owner's retained invocation can request host operations. */
export function validateHuddleOperation(
  home: string,
  binding: RuntimeBinding,
  client: HuddleOwnerClient,
  operation: HuddleAgentOperation,
) {
  if (
    binding.role !== 'huddle' ||
    client.state?.capabilities.operations !== 2 ||
    canonicalHuddleJson(operation.scope.owner) !==
      canonicalHuddleJson(runtimeBindingIdentity(binding)) ||
    canonicalHuddleJson(client.state.identity) !== canonicalHuddleJson(operation.scope.owner) ||
    operation.scope.target.projectId !== binding.project_id
  )
    throw new Error('Huddle operation differs from its authenticated owner scope');
  const snapshot = new HuddleRevisionStore(home, binding.runtime_id, binding.huddle_id!).read(
    operation.scope.revision,
  );
  const node = snapshot.definition.nodes.find((node) => node.id === operation.node);
  const component = snapshot.components[operation.node];
  if (
    !node ||
    !component ||
    !['script', 'readout'].includes(component.category) ||
    !component.capabilities.includes('sessions') ||
    component.parameters.worktree?.editor !== 'worktree' ||
    !Object.values(component.parameters).some((parameter) => parameter.editor === 'session')
  )
    throw new Error('Retained node did not declare agent operations');
  // The independent owner resolved the handle against this invocation's retained
  // activation bindings. Host dispatch additionally rechecks live DB scope and incarnation.
}
