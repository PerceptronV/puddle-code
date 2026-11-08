import { canonicalHuddleJson, type HuddleWorkerRequest } from '@puddle/shared';
import type { HuddleLedger } from '../state/ledger.js';
import type { HuddleRevisionController } from '../control/revisions.js';
import { prepareHuddleWorkerJob } from '../../../huddle/definitions/worker.js';
import { HuddleReadoutDelivery } from './delivery.js';

/** Observe the original captured destination; never dispatch or resume graph work. */
export function prepareReadoutObservation(
  ledger: HuddleLedger,
  revisions: Pick<HuddleRevisionController, 'forExecution'>,
  operationId: string,
) {
  const operation = ledger.operations.get(operationId);
  const invocation = ledger.invocations.get(operation.invocationId);
  const execution = ledger.executions.get(operation.executionId);
  if (
    operation.kind !== 'readout' ||
    !operation.consumed ||
    operation.state !== 'unknown' ||
    invocation.id !== operationId ||
    invocation.executionId !== execution.id ||
    ['pending', 'running'].includes(invocation.state) ||
    ['pending', 'running'].includes(execution.state)
  )
    throw new Error('Only an uncertain readout in an ended execution can be observed');
  const { snapshot, activation } = revisions.forExecution(execution.id);
  const component = snapshot.components[invocation.node];
  if (component?.category !== 'readout' || component.readout?.reconciliation !== 'observe')
    throw new Error('This captured readout does not support observation');
  const delivery = new HuddleReadoutDelivery(ledger, invocation, component);
  if (
    canonicalHuddleJson(operation.input) !== canonicalHuddleJson(delivery.envelope) ||
    canonicalHuddleJson(operation.target) !==
      canonicalHuddleJson({
        component: component.id,
        version: component.version,
        revision: invocation.revision,
        node: invocation.node,
        support: component.readout,
      })
  )
    throw new Error('Readout observation differs from its retained delivery intent');
  const job = prepareHuddleWorkerJob(
    snapshot,
    invocation,
    activation.variables,
    activation.bindings[invocation.node] ?? {},
    { delivery: delivery.envelope, mode: 'observe' },
  );
  return {
    job,
    invocation,
    worktree: activation.worktree,
    async request(message: HuddleWorkerRequest, signal: AbortSignal) {
      signal.throwIfAborted();
      if (message.action.kind !== 'readout-result')
        throw new Error('Readout observation cannot emit events or dispatch agent operations');
      delivery.accept(message.action.result, 'observe');
      return null;
    },
    failed(error: Error) {
      // A receipt committed before worker/reply loss remains authoritative.
      if (ledger.operations.get(operationId).state === 'unknown')
        ledger.operations.unknown(operationId, error.message.slice(0, 4096));
    },
  };
}
