import {
  isHuddleJson,
  validateHuddleValue,
  type HuddleComponent,
  type HuddleJson,
  type HuddlePort,
} from '@puddle/shared';
import type { HuddleNodeContext, HuddleValues } from './context.js';
import type { HuddleNodeModule } from './node.js';

function immutable(value: HuddleJson): HuddleJson {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function snapshot(values: HuddleValues): HuddleValues {
  if (
    values === null ||
    typeof values !== 'object' ||
    !isHuddleJson(values) ||
    Array.isArray(values)
  )
    throw new Error('Expected bounded named port values');
  return immutable(structuredClone(values)) as HuddleValues;
}

function validatePorts(
  contracts: Record<string, HuddlePort>,
  values: HuddleValues,
  direction: string,
) {
  for (const [port, contract] of Object.entries(contracts)) {
    if (!Object.hasOwn(values, port)) {
      if (contract.required) throw new Error(`Missing ${direction} port: ${port}`);
      continue;
    }
    if (validateHuddleValue(contract.schema, values[port]).length)
      throw new Error(`Invalid ${direction} value: ${port}`);
  }
  for (const port of Object.keys(values)) {
    if (!Object.hasOwn(contracts, port)) throw new Error(`Unknown ${direction} port: ${port}`);
  }
}

/** Called inside an isolated node worker, never on the daemon/owner event loop. */
export async function executeHuddleNode(
  node: HuddleNodeModule,
  component: HuddleComponent,
  context: HuddleNodeContext,
): Promise<HuddleValues> {
  context.signal.throwIfAborted();
  if (component.category !== 'script') throw new Error('HuddleNode requires a script component');
  const inputs = snapshot(context.inputs);
  const parameters = snapshot(context.parameters);
  validatePorts(component.inputs, inputs, 'input');
  for (const [name, parameter] of Object.entries(component.parameters)) {
    if (!Object.hasOwn(parameters, name)) {
      if (parameter.required) throw new Error(`Missing node parameter: ${name}`);
    } else if (validateHuddleValue(parameter.schema, parameters[name]).length)
      throw new Error(`Invalid node parameter: ${name}`);
  }
  for (const name of Object.keys(parameters)) {
    if (!Object.hasOwn(component.parameters, name))
      throw new Error(`Unknown node parameter: ${name}`);
  }
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
