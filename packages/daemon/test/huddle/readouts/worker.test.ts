import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { huddleLedgerFixture } from '../../helpers/huddle/ledger.js';
import { readoutSnapshot } from '../../helpers/huddle/readout.js';
import { workerJob, workerTestHarness } from '../../helpers/huddle/worker.js';

const workers = workerTestHarness();
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function job(source: string, mode: 'observe' | 'deliver' = 'observe') {
  const f = huddleLedgerFixture();
  cleanups.push(f.cleanup);
  const component = readoutSnapshot(f.identity.huddleId, source, {
    idempotent: true,
    reconciliation: 'observe',
    cancellation: 'none',
  }).components.worker!;
  const invocationId = randomUUID();
  return workerJob(source, {
    invocationId,
    component,
    readout: {
      mode,
      delivery: {
        format: 1,
        id: invocationId,
        invocationId,
        idempotencyKey: 'a'.repeat(64),
        event: f.event(),
        node: 'worker',
        inputs: { value: 21 },
      },
    },
  });
}

it('runs declared observation without calling deliver and returns an immutable confirmed receipt', async () => {
  const input = job(`import {HuddleReadout} from 'puddlang/huddle';
    export default HuddleReadout({contract:'./node.json', async deliver() { throw new Error('Must not resend'); },
      async observe(context, delivery) {
        if (!Object.isFrozen(delivery) || !Object.isFrozen(context.parameters)) throw new Error('Mutable input');
        return {status:'delivered',receipt:{key:delivery.idempotencyKey},outputs:{completed:delivery.inputs.value*2}};
      }});`);
  const results: unknown[] = [];
  const handle = workers.start(input, {
    request: async (request) => {
      expect(request.action.kind).toBe('readout-result');
      results.push(request.action);
      return null;
    },
  });
  await expect(handle.result).resolves.toEqual({ completed: 42 });
  expect(results).toEqual([
    {
      kind: 'readout-result',
      result: { status: 'delivered', receipt: { key: 'a'.repeat(64) }, outputs: { completed: 42 } },
    },
  ]);
});

it('refuses mismatched delivery identity before evaluating captured project code', () => {
  const input = job(`throw new Error('Evaluated source');`);
  input.readout!.delivery.node = 'different';
  expect(() => workers.start(input)).toThrow('differs from its captured invocation');
});

it('requires the exported observation method to match the captured contract', async () => {
  const input = job(`import {HuddleReadout} from 'puddlang/huddle';
    export default HuddleReadout({contract:'./node.json', async deliver() { throw new Error('Must not call delivery'); }});`);
  await expect(workers.start(input).result).rejects.toThrow('observation support differs');
});
