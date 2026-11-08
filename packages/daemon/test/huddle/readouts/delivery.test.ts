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

const workers = workerTestHarness();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const wrap = (
  body: string,
) => `import {HuddleReadout} from 'puddlang/huddle'; import fs from 'node:fs';
export default HuddleReadout({contract:'./node.json', async deliver(context, delivery) { ${body} }});`;
function fixture(source: string) {
  const f = huddleLedgerFixture();
  const store = new HuddleRevisionStore(f.home, f.identity.runtimeId, f.identity.huddleId);
  const revisions = new HuddleRevisionController(f.ledger, store);
  const snapshot = readoutSnapshot(f.identity.huddleId, source);
  revisions.apply(snapshot, { id: randomUUID(), worktree: f.home, variables: {}, bindings: {} }, 0);
  f.ledger.activations.setIntent(1, 'armed', false);
  const options = {
    nodePath: process.execPath,
    entryPath: join(workers.stage, 'daemon/huddle/runner.js'),
  };
  const scheduler = new HuddleScheduler(f.ledger, revisions, options);
  cleanups.push(async () => {
    if (scheduler.hasLiveWorkers) await scheduler.halt('stopped', 'Fixture cleanup');
    f.cleanup();
  });
  const admit = () => admitManualHuddle(f.ledger, store, 'run', 'source-event', f.home);
  const operation = () => JSON.parse(f.ledger.page('operations')[0]!.body);
  return { f, store, scheduler, options, admit, operation };
}

it('consumes delivery before custom code, retains a receipt and routes confirmed outputs without replay after reopening', async () => {
  const { f, store, scheduler, options, admit, operation } = fixture(
    wrap(`
    if (!Object.isFrozen(delivery) || !Object.isFrozen(delivery.inputs) || !Object.isFrozen(delivery.event.scope)) throw new Error('mutable envelope');
    fs.appendFileSync(delivery.inputs.value + '/sent', delivery.idempotencyKey + '\\n');
    while (!fs.existsSync(delivery.inputs.value + '/release')) await new Promise(r => setTimeout(r, 10));
    return {status:'delivered', receipt:{externalId:'delivery-1'}, outputs:{completed:42}};
  `),
  );
  const run = admit();
  const draining = scheduler.drain();
  await until(() => existsSync(join(f.home, 'sent')));
  expect(operation()).toMatchObject({
    kind: 'readout',
    state: 'dispatched',
    consumed: true,
    input: { node: 'worker', inputs: { value: f.home }, event: { executionId: run.execution.id } },
  });
  const key = operation().input.idempotencyKey;
  expect(readFileSync(join(f.home, 'sent'), 'utf8')).toBe(`${key}\n`);
  writeFileSync(join(f.home, 'release'), '');
  await draining;
  expect(f.ledger.executions.get(run.execution.id).state).toBe('completed');
  expect(operation()).toMatchObject({
    state: 'completed',
    result: {
      status: 'delivered',
      receipt: { externalId: 'delivery-1' },
      outputs: { completed: 42 },
    },
  });
  expect(
    f.ledger
      .page('invocations')
      .map((row) => JSON.parse(row.body))
      .find((row) => row.node === 'result'),
  ).toMatchObject({ state: 'completed', inputs: { value: 42 } });
  f.reopen();
  const replacement = new HuddleScheduler(
    f.ledger,
    new HuddleRevisionController(f.ledger, store),
    options,
  );
  await replacement.drain();
  expect(readFileSync(join(f.home, 'sent'), 'utf8')).toBe(`${key}\n`);
  expect(admit().duplicate).toBe(true);
});

it.each([
  ['failed', "return {status:'failed',message:'destination refused'};", 'failed'],
  ['unknown', "return {status:'unknown',message:'reply lost'};", 'unknown'],
  ['throw', "throw new Error('reply lost after send');", 'unknown'],
  ['exit without receipt', 'process.exit(0);', 'unknown'],
  [
    'invalid output',
    "return {status:'delivered',receipt:null,outputs:{unexpected:42}};",
    'unknown',
  ],
] as const)(
  'keeps %s distinct from delivered and never replays consumed work',
  async (_name, body, state) => {
    const { f, scheduler, admit, operation } = fixture(
      wrap(`
    fs.appendFileSync(delivery.inputs.value + '/sent', 'x'); ${body}
  `),
    );
    const run = admit();
    await scheduler.drain();
    expect(f.ledger.executions.get(run.execution.id).state).toBe('failed');
    expect(operation()).toMatchObject({ state, consumed: true });
    expect(() => f.ledger.operations.dispatch(operation().id)).toThrow();
    await scheduler.drain();
    expect(readFileSync(join(f.home, 'sent'), 'utf8')).toBe('x');
    expect(
      f.ledger
        .page('invocations')
        .map((row) => JSON.parse(row.body))
        .some((row) => row.node === 'result'),
    ).toBe(false);
  },
);

it('signals cooperative cancellation, waits for worker exit and retains an unknown external outcome', async () => {
  const { f, scheduler, admit, operation } = fixture(
    wrap(`
    context.signal.addEventListener('abort', () => fs.writeFileSync(delivery.inputs.value + '/cancelled', 'x'));
    fs.writeFileSync(delivery.inputs.value + '/sent', 'x');
    await new Promise(() => {});
  `),
  );
  const run = admit(),
    draining = scheduler.drain();
  await until(() => existsSync(join(f.home, 'sent')));
  await scheduler.halt('interrupted', 'User interrupt');
  await draining;
  expect(existsSync(join(f.home, 'cancelled'))).toBe(true);
  expect(scheduler.hasLiveWorkers).toBe(false);
  expect(operation()).toMatchObject({ state: 'unknown', consumed: true });
  expect(f.ledger.executions.get(run.execution.id).state).toBe('interrupted');
});

it('retains a committed receipt after a lost acknowledgement without publishing unconfirmed worker outputs', async () => {
  const { f, scheduler, admit, operation } = fixture(
    wrap(`
    fs.appendFileSync(delivery.inputs.value + '/sent', 'x');
    return {status:'delivered',receipt:{id:'confirmed'},outputs:{completed:42}};
  `),
  );
  const settle = f.ledger.operations.settle.bind(f.ledger.operations);
  vi.spyOn(f.ledger.operations, 'settle').mockImplementation((...args) => {
    settle(...args);
    throw new Error('Fixture acknowledgement lost after receipt commit');
  });
  const run = admit();
  await scheduler.drain();
  expect(f.ledger.executions.get(run.execution.id).state).toBe('failed');
  expect(operation()).toMatchObject({
    state: 'completed',
    result: { status: 'delivered', receipt: { id: 'confirmed' } },
  });
  expect(readFileSync(join(f.home, 'sent'), 'utf8')).toBe('x');
  expect(
    f.ledger
      .page('invocations')
      .map((row) => JSON.parse(row.body))
      .some((row) => row.node === 'result'),
  ).toBe(false);
});
