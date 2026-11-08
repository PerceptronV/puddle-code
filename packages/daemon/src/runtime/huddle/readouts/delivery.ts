import {
  canonicalHuddleJson,
  huddleDeliverySchema,
  huddleDeliveryResultSchema,
  huddleJsonSchema,
  validateHuddleValue,
  type HuddleComponent,
  type HuddleInvocationRecord,
  type HuddleJson,
  type HuddleDeliveryResult,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import type { HuddleLedger } from '../state/ledger.js';

/** One external delivery per immutable invocation; consumption never grants a retry. */
export class HuddleReadoutDelivery {
  readonly envelope;
  constructor(
    private readonly ledger: HuddleLedger,
    private readonly invocation: HuddleInvocationRecord,
    private readonly component: HuddleComponent,
  ) {
    this.envelope = huddleDeliverySchema.parse({
      format: 1,
      id: invocation.id,
      invocationId: invocation.id,
      node: invocation.node,
      idempotencyKey: digest(
        canonicalHuddleJson({
          scope: ledger.identity,
          revision: invocation.revision,
          invocation: invocation.id,
        }),
      ),
      event: ledger.executions.event(invocation.executionId),
      inputs: invocation.inputs,
    });
    huddleJsonSchema.parse(this.envelope);
  }
  dispatch() {
    this.ledger.operations.prepare({
      id: this.envelope.id,
      invocationId: this.invocation.id,
      kind: 'readout',
      target: {
        component: this.component.id,
        version: this.component.version,
        revision: this.invocation.revision,
        node: this.invocation.node,
        support: this.component.readout!,
      },
      input: this.envelope,
    });
    this.ledger.operations.dispatch(this.envelope.id);
  }
  accept(input: HuddleDeliveryResult) {
    const result = huddleDeliveryResultSchema.parse(input);
    huddleJsonSchema.parse(result);
    if (result.status === 'delivered') {
      const outputs = result.outputs ?? {};
      for (const [port, contract] of Object.entries(this.component.outputs)) {
        if (
          (!Object.hasOwn(outputs, port) && contract.required) ||
          (Object.hasOwn(outputs, port) &&
            validateHuddleValue(contract.schema, outputs[port]).length)
        )
          throw new Error('Readout returned invalid completion output');
      }
      if (Object.keys(outputs).some((port) => !Object.hasOwn(this.component.outputs, port)))
        throw new Error('Readout returned an unknown completion output');
      this.ledger.operations.settle(this.envelope.id, 'completed', result);
    } else if (result.status === 'failed') {
      this.ledger.operations.settle(this.envelope.id, 'failed', result);
      throw new Error(`Readout failed: ${result.message}`);
    } else {
      this.ledger.operations.unknown(this.envelope.id, result.message);
      throw new Error(`Readout delivery is unknown: ${result.message}`);
    }
  }
  requireDelivered(outputs: Record<string, HuddleJson>) {
    const operation = this.ledger.operations.get(this.envelope.id);
    if (operation.state !== 'completed') throw new Error('Readout has no confirmed delivery');
    const result = huddleDeliveryResultSchema.parse(operation.result);
    if (
      result.status !== 'delivered' ||
      canonicalHuddleJson(result.outputs ?? {}) !== canonicalHuddleJson(outputs)
    )
      throw new Error('Readout completion differs from its retained delivery');
  }
}
