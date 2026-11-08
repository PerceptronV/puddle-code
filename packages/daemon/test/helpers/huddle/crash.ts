import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HuddleDefinition, HuddleEvent, HuddleLedgerIdentity } from '@puddle/shared';
import { HuddleLedger } from '../../../src/runtime/huddle/state/ledger.js';

const [home, encoded] = process.argv.slice(2);
if (!home || !encoded) throw new Error('Missing isolated huddle crash fixture');
const input = JSON.parse(encoded) as {
  identity: HuddleLedgerIdentity;
  event: HuddleEvent;
  limits: HuddleDefinition['execution'];
  invocationId: string;
  operationId: string;
};
const ledger = new HuddleLedger(home, input.identity);
ledger.executions.accept(input.event, null, 1, input.limits);
ledger.executions.start(input.event.executionId);
ledger.invocations.queue({
  id: input.invocationId,
  executionId: input.event.executionId,
  revision: input.event.revision,
  node: 'writer',
  activation: 'seed',
  iteration: 0,
  inputs: {},
});
ledger.invocations.start(input.invocationId);
const target = join(home, 'effect.txt');
ledger.operations.prepare({
  id: input.operationId,
  invocationId: input.invocationId,
  kind: 'file-write',
  target,
  input: 'one accepted dispatch',
});
ledger.operations.dispatch(input.operationId);
appendFileSync(target, 'sent\n');
// Kill only this isolated fixture, without clean ledger shutdown or promise cleanup.
process.kill(process.pid, 'SIGKILL');
