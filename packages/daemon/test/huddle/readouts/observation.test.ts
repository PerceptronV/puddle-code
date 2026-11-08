import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { huddleLedgerFixture } from '../../helpers/huddle/ledger.js';
import { readoutSnapshot } from '../../helpers/huddle/readout.js';
import { workerTestHarness } from '../../helpers/huddle/worker.js';
import { until } from '../../helpers/huddle/controller.js';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { HuddleRevisionController } from '../../../src/runtime/huddle/control/revisions.js';
import { HuddleScheduler } from '../../../src/runtime/huddle/execution/scheduler.js';
import { admitManualHuddle } from '../../../src/runtime/huddle/control/manual.js';
import { prepareReadoutObservation } from '../../../src/runtime/huddle/readouts/observation.js';

const workers = workerTestHarness();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(body: string) {
  const f = huddleLedgerFixture();
  const store = new HuddleRevisionStore(f.home, f.identity.runtimeId, f.identity.huddleId);
  const revisions = new HuddleRevisionController(f.ledger, store);
  const snapshot = readoutSnapshot(
    f.identity.huddleId,
    `
    import {HuddleReadout} from 'puddlang/huddle'; import fs from 'node:fs';
    export default HuddleReadout({contract:'./node.json',
      async deliver(context, delivery) {
        fs.appendFileSync(delivery.inputs.value + '/sent', 'x');
        return {status:'unknown', message:'lost receipt'};
      },
      async observe(context, delivery) {
        fs.appendFileSync(delivery.inputs.value + '/observed', delivery.idempotencyKey + '\\n');
        ${body}
      }
    });`,
    { idempotent: false, reconciliation: 'observe', cancellation: 'signal' },
  );
  revisions.apply(snapshot, { id: randomUUID(), worktree: f.home, variables: {}, bindings: {} }, 0);
  f.ledger.activations.setIntent(1, 'armed', false);
  const scheduler = new HuddleScheduler(f.ledger, revisions, {
    nodePath: process.execPath,
    entryPath: join(workers.stage, 'daemon/huddle/runner.js'),
    maxWorkers: 1,
  });
  cleanups.push(async () => {
    if (scheduler.hasLiveWorkers) await scheduler.halt('stopped', 'Fixture cleanup');
    f.cleanup();
  });
  const run = admitManualHuddle(f.ledger, store, 'run', 'source-event', f.home);
  await scheduler.drain();
  const operation = () => f.ledger.operations.get(f.ledger.page('operations')[0]!.id);
  expect(operation().state).toBe('unknown');
  return { f, store, revisions, scheduler, snapshot, run, operation };
}

it('observes the captured revision after Apply, settles the receipt and leaves the ended graph untouched', async () => {
  const { f, scheduler, revisions, snapshot, run, operation } = await fixture(
    "return {status:'delivered',receipt:{id:'receipt'},outputs:{completed:42}};",
  );
  const before = f.ledger.executions.get(run.execution.id);
  const invocations = f.ledger.page('invocations');
  const later = readoutSnapshot(
    f.identity.huddleId,
    `throw new Error('Must not evaluate newer source');`,
  );
  revisions.apply(later, { id: randomUUID(), worktree: f.home, variables: {}, bindings: {} }, 2);
  expect(later.digest).not.toBe(snapshot.digest);
  scheduler.observeReadout(operation().id);
  await scheduler.drain();
  expect(operation()).toMatchObject({
    state: 'completed',
    result: { status: 'delivered', receipt: { id: 'receipt' } },
  });
  expect(f.ledger.executions.get(run.execution.id)).toEqual(before);
  expect(f.ledger.page('invocations')).toEqual(invocations);
  expect(readFileSync(join(f.home, 'sent'), 'utf8')).toBe('x');
  const input = operation().input as { idempotencyKey: string };
  expect(readFileSync(join(f.home, 'observed'), 'utf8')).toBe(input.idempotencyKey + '\n');
  expect(() => scheduler.observeReadout(operation().id)).toThrow(/uncertain/);
});

it('uses the shared worker capacity and cancels observation after interruption without resending', async () => {
  const { f, store, scheduler, operation } = await fixture(`
    context.signal.addEventListener('abort', () => fs.writeFileSync(delivery.inputs.value + '/cancelled', 'x'));
    await new Promise(() => {});
  `);
  scheduler.observeReadout(operation().id);
  const pending = scheduler.drain();
  await until(() => existsSync(join(f.home, 'observed')));
  expect(() => scheduler.observeReadout(operation().id)).toThrow(/already running|capacity/);
  const next = admitManualHuddle(f.ledger, store, 'run', 'second-event', f.home);
  void scheduler.drain();
  await until(() => f.ledger.executions.get(next.execution.id).state === 'running');
  expect(
    f.ledger.page('invocations', { parent: next.execution.id, state: 'pending' }),
  ).toHaveLength(1);
  expect(readFileSync(join(f.home, 'sent'), 'utf8')).toBe('x');
  await scheduler.halt('interrupted', 'User interrupt');
  await pending;
  expect(scheduler.hasLiveWorkers).toBe(false);
  expect(existsSync(join(f.home, 'cancelled'))).toBe(true);
  expect(operation()).toMatchObject({ state: 'unknown', consumed: true });
  expect(readFileSync(join(f.home, 'sent'), 'utf8')).toBe('x');
});

it('rejects event emission and agent operations from observation without invoking dispatch', async () => {
  const { f, revisions, operation } = await fixture("throw new Error('must not run');");
  const observation = prepareReadoutObservation(f.ledger, revisions, operation().id);
  for (const action of [
    { kind: 'emit' as const, sequence: 1, port: 'completed', value: 42 },
    { kind: 'operation' as const, operation: { op: 'attach' as const, reference: 'some-agent' } },
  ]) {
    await expect(
      observation.request(
        { type: 'request', id: randomUUID(), action },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/cannot emit events or dispatch agent operations/);
  }
  expect(operation().state).toBe('unknown');
  expect(f.ledger.page('operations')).toHaveLength(1);
  expect(existsSync(join(f.home, 'observed'))).toBe(false);
});

it.each([
  ["return {status:'delivered',receipt:'confirmed without graph outputs'};", 'completed'],
  ["return {status:'unknown',message:'destination still unavailable'};", 'unknown'],
  ["return {status:'failed',message:'destination proves refusal'};", 'failed'],
  ["throw new Error('observation disconnected');", 'unknown'],
  ['process.exit(0);', 'unknown'],
  ["return {status:'delivered',receipt:null,outputs:{unexpected:42}};", 'unknown'],
] as const)(
  'retains observation outcome for %s without rerunning the graph',
  async (body, state) => {
    const { f, scheduler, run, operation } = await fixture(body);
    scheduler.observeReadout(operation().id);
    await scheduler.drain();
    expect(operation().state).toBe(state);
    expect(f.ledger.executions.get(run.execution.id).state).toBe('failed');
    expect(readFileSync(join(f.home, 'sent'), 'utf8')).toBe('x');
  },
);

it('retains an observation receipt after acknowledgement loss', async () => {
  const { f, scheduler, operation } = await fixture(
    "return {status:'delivered',receipt:42,outputs:{completed:42}};",
  );
  const settle = f.ledger.operations.settle.bind(f.ledger.operations);
  vi.spyOn(f.ledger.operations, 'settle').mockImplementation((...args) => {
    settle(...args);
    throw new Error('Lost acknowledgement after commit');
  });
  scheduler.observeReadout(operation().id);
  await scheduler.drain();
  expect(operation()).toMatchObject({ state: 'completed', result: { receipt: 42 } });
  expect(readFileSync(join(f.home, 'sent'), 'utf8')).toBe('x');
});

it('rejects observation when retained delivery intent is altered, before evaluating source', async () => {
  const { f, scheduler, operation } = await fixture("throw new Error('must not run');");
  const get = f.ledger.operations.get.bind(f.ledger.operations);
  const id = operation().id;
  vi.spyOn(f.ledger.operations, 'get').mockImplementation((key) => ({ ...get(key), input: null }));
  expect(() => scheduler.observeReadout(id)).toThrow(/retained delivery intent/);
  expect(existsSync(join(f.home, 'observed'))).toBe(false);
  expect(readFileSync(join(f.home, 'sent'), 'utf8')).toBe('x');
});

it('allows a later explicit observation after an inconclusive result without automatic polling', async () => {
  const { f, scheduler, operation } = await fixture(`
    if (!fs.existsSync(delivery.inputs.value + '/found')) return {status:'unknown',message:'not yet visible'};
    return {status:'delivered', receipt:'found', outputs:{completed:true}};
  `);
  scheduler.observeReadout(operation().id);
  await scheduler.drain();
  await scheduler.drain();
  expect(readFileSync(join(f.home, 'observed'), 'utf8').trim().split('\n')).toHaveLength(1);
  writeFileSync(join(f.home, 'found'), 'x');
  scheduler.observeReadout(operation().id);
  await scheduler.drain();
  expect(operation().state).toBe('completed');
  expect(readFileSync(join(f.home, 'sent'), 'utf8')).toBe('x');
});
