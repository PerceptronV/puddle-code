import {
  huddleDeliverySchema,
  huddleDeliveryResultSchema,
  huddleJsonSchema,
  type HuddleComponent,
  type HuddleDelivery,
  type HuddleDeliveryResult,
} from '@puddle/shared';
import type { HuddleReadoutAdapter, HuddleExtensionContext } from './context.js';
import { immutable, snapshot, validatePorts, validateParameters } from './values.js';

/** One delivery/observation in an isolated worker; uncertain external effects are never inferred. */
export async function executeHuddleReadout(
  adapter: HuddleReadoutAdapter,
  component: HuddleComponent,
  context: HuddleExtensionContext,
  input: HuddleDelivery,
  mode: 'deliver' | 'observe',
): Promise<HuddleDeliveryResult> {
  context.signal.throwIfAborted();
  if (component.category !== 'readout' || !component.readout)
    throw new Error('HuddleReadout requires a declared readout component');
  if ((component.readout.reconciliation === 'observe') !== (typeof adapter.observe === 'function'))
    throw new Error('Readout observation support differs from its captured declaration');
  const delivery = huddleDeliverySchema.parse(input);
  validatePorts(component.inputs, delivery.inputs, 'input', component.activation);
  const parameters = snapshot(context.parameters);
  validateParameters(component, parameters);
  immutable(delivery);
  const action = mode === 'deliver' ? adapter.deliver : adapter.observe;
  if (!action) throw new Error('Readout does not support observation');
  const result = huddleDeliveryResultSchema.parse(
    await action(
      {
        ...context,
        parameters,
        bindings: Object.freeze({ ...context.bindings }),
      },
      delivery,
    ),
  );
  context.signal.throwIfAborted();
  huddleJsonSchema.parse(result);
  if (result.status === 'delivered')
    validatePorts(component.outputs, result.outputs ?? {}, 'output');
  return immutable(result) as HuddleDeliveryResult;
}
