import {
  coreHuddleComponents,
  validateHuddleHostTrigger,
  validateHuddleValue,
  type HuddleComponent,
  type HuddleJson,
} from '@puddle/shared';
import type { HuddleNodeContext, HuddleValues } from './context.js';
import type { HuddleNodeModule } from './node.js';
import { immutable, snapshot, validatePorts, validateParameters } from './values.js';

/** Called inside an isolated node worker, never on the daemon/owner event loop. */
export async function executeHuddleNode(
  node: HuddleNodeModule,
  component: HuddleComponent,
  context: HuddleNodeContext,
): Promise<HuddleValues> {
  context.signal.throwIfAborted();
  const host =
    component.hostTrigger &&
    coreHuddleComponents.get(`${component.hostTrigger.component}@${component.hostTrigger.version}`);
  if (component.category !== 'script' && !(component.category === 'trigger' && host))
    throw new Error('HuddleNode requires a script or declared host trigger adapter');
  const hostError = validateHuddleHostTrigger(component);
  if (hostError) throw new Error(hostError);
  const inputs = snapshot(context.inputs);
  const parameters = snapshot(context.parameters);
  validatePorts(host ? host.outputs : component.inputs, inputs, 'input', component.activation);
  validateParameters(component, parameters);
  const pending = new Set<Promise<void>>();
  const completedPorts = Object.fromEntries(
    Object.entries(component.outputs).filter(([, port]) => port.emission === 'completion'),
  );
  let closed = false;
  let emissionFailure: unknown;
  const emit = (port: string, value: HuddleJson): Promise<void> => {
    const task = (async () => {
      context.signal.throwIfAborted();
      if (closed) throw new Error('Node invocation already finished');
      const contract = component.outputs[port];
      if (!Object.hasOwn(component.outputs, port) || contract?.emission !== 'event')
        throw new Error(`Output is not an event port: ${port}`);
      if (validateHuddleValue(contract.schema, value).length)
        throw new Error(`Invalid event value: ${port}`);
      await context.emit(port, immutable(structuredClone(value)));
      context.signal.throwIfAborted();
    })();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      (error: unknown) => {
        emissionFailure = error;
        pending.delete(task);
      },
    );
    return task;
  };
  try {
    const result = await node.run({
      ...context,
      inputs,
      parameters,
      bindings: Object.freeze({ ...context.bindings }),
      emit,
    });
    context.signal.throwIfAborted();
    if (pending.size) throw new Error('Node finished with unawaited emissions');
    if (emissionFailure) throw emissionFailure;
    const outputs = snapshot(result);
    validatePorts(completedPorts, outputs, 'output');
    return outputs;
  } finally {
    closed = true;
  }
}
