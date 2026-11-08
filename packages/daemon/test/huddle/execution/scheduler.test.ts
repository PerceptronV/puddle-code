import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { huddleResultReadout } from '../../../src/huddle/components/core.js';
import { huddleRevisionDigest } from '../../../src/huddle/definitions/revision.js';
import { huddleDefinitionSchema, type HuddleJson } from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from '../../../src/huddle/definitions/capture.js';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { HuddleRevisionController } from '../../../src/runtime/huddle/control/revisions.js';
import { admitManualHuddle } from '../../../src/runtime/huddle/control/manual.js';
import { HuddleScheduler } from '../../../src/runtime/huddle/execution/scheduler.js';
import type { HuddleAttemptOptions } from '../../../src/runtime/huddle/execution/attempts.js';
import { huddleLedgerFixture, type HuddleLedgerFixture } from '../../helpers/huddle/ledger.js';
import { invocations } from '../../helpers/huddle/graph.js';
import { schedulerSnapshot } from '../../helpers/huddle/scheduler.js';
import { workerTestHarness } from '../../helpers/huddle/worker.js';
import { RuntimeBufferBudget } from '../../../src/runtime/resources/budget.js';

const workers = workerTestHarness();
const fixtures: Array<{ f: HuddleLedgerFixture; scheduler: HuddleScheduler }> = [];
afterEach(async () => {
  for (const { f, scheduler } of fixtures.splice(0)) {
    await scheduler.halt('stopped', 'Fixture cleanup');
    f.cleanup();
  }
});
const wrap = (body: string) =>
  `import {HuddleNode} from 'puddlang/huddle'; export default HuddleNode({contract:'./node.json', async run({inputs,emit}) { ${body} }});`;

function setup(source: string, feedback?: number, options: Partial<HuddleAttemptOptions> = {}) {
  const f = huddleLedgerFixture();
  const store = new HuddleRevisionStore(f.home, f.identity.runtimeId, f.identity.huddleId);
  const revisions = new HuddleRevisionController(f.ledger, store);
  const sourceSnapshot = schedulerSnapshot(f.identity.huddleId, source, feedback);
  const apply = (source: HuddleDefinitionSnapshot) =>
    revisions.apply(
      source,
      { id: randomUUID(), worktree: f.home, variables: {}, bindings: {} },
      f.ledger.activations.current().generation,
    );
  apply(sourceSnapshot);
  f.ledger.activations.setIntent(1, 'armed', false);
  const scheduler = new HuddleScheduler(f.ledger, revisions, {
    nodePath: process.execPath,
    entryPath: join(workers.stage, 'daemon/huddle/runner.js'),
    ...options,
  });
  fixtures.push({ f, scheduler });
  const admit = (data: HuddleJson, key = randomUUID()) =>
    admitManualHuddle(f.ledger, store, 'run', key, data);
  return { f, scheduler, apply, admit, sourceSnapshot };
}

describe('owner graph scheduling with real script workers', () => {
  it('refuses a worker before script execution when the shared host allowance is exhausted', async () => {
    const allowance = new RuntimeBufferBudget({ bytes: 4 * 1024 * 1024, count: 100 });
    const { f, scheduler, admit } = setup(wrap('return {completed: 42};'), undefined, {
      allowance,
    });
    const run = admit(21);
    await scheduler.drain();
    expect(f.ledger.executions.get(run.execution.id)).toMatchObject({
      state: 'failed',
      error: 'Host memory admission is unavailable for a huddle worker',
    });
    expect(invocations(f, run.execution.id, 'worker')[0]?.state).toBe('cancelled');
    expect(scheduler.hasLiveWorkers).toBe(false);
    expect(allowance.usedBytes).toBe(0);
  });
  it('returns retained graph and worker charges after confirmed completion', async () => {
    const allowance = new RuntimeBufferBudget({ bytes: 256 * 1024 * 1024, count: 100 });
    const { f, scheduler, admit } = setup(wrap('return {completed: 42};'), undefined, {
      allowance,
    });
    const run = admit(21);
    await scheduler.drain();
    expect(f.ledger.executions.get(run.execution.id).state).toBe('completed');
    expect(allowance.usedBytes).toBe(0);
  });
  it('routes an explicit event to a result readout while its source occupies the only worker slot', async () => {
    let emitted!: () => void;
    const ready = new Promise<void>((resolve) => {
      emitted = resolve;
    });
    const { f, scheduler, admit, apply, sourceSnapshot } = setup(
      wrap(
        'await emit("turn", inputs.value); process.stdout.write("event-sent"); await new Promise(() => {});',
      ),
      undefined,
      {
        maxWorkers: 1,
        log: (_id, _stream, text) => {
          if (text.includes('event-sent')) emitted();
        },
      },
    );
    sourceSnapshot.definition.nodes.push(
      huddleDefinitionSchema.shape.nodes.element.parse({
        id: 'live',
        source: { kind: 'builtin', component: huddleResultReadout.id, version: 1 },
      }),
    );
    sourceSnapshot.definition.edges.push({
      id: 'turn-live',
      from: { node: 'worker', port: 'turn' },
      to: { node: 'live', port: 'value' },
    });
    sourceSnapshot.components['live'] = huddleResultReadout;
    sourceSnapshot.files['huddle.json'] = JSON.stringify(sourceSnapshot.definition);
    sourceSnapshot.digest = huddleRevisionDigest(sourceSnapshot.files, sourceSnapshot.components);
    apply(sourceSnapshot);
    const event = admit(21);
    const draining = scheduler.drain();
    await ready;
    await vi.waitFor(() =>
      expect(invocations(f, event.execution.id, 'live')[0]?.state).toBe('completed'),
    );
    expect(invocations(f, event.execution.id, 'worker')[0]!.state).toBe('running');
    await scheduler.halt('stopped', 'Fixture observed the live output');
    await draining;
    expect(invocations(f, event.execution.id, 'live')[0]!.inputs).toEqual({ value: 21 });
  });
  it('runs a manual graph to completion, retains one result and observes duplicate Run requests', async () => {
    const { f, scheduler, admit } = setup(
      wrap('await emit("turn", inputs.value); return {completed: inputs.value * 2};'),
    );
    const key = randomUUID();
    const event = admit(21, key);
    await scheduler.drain();
    expect(f.ledger.executions.get(event.execution.id).state).toBe('completed');
    expect(invocations(f, event.execution.id, 'result').map((record) => record.inputs)).toEqual([
      { value: 42 },
    ]);
    expect(admit(21, key).duplicate).toBe(true);
    await scheduler.drain();
    expect(invocations(f, event.execution.id)).toHaveLength(2);
    expect(scheduler.hasLiveWorkers).toBe(false);
  });

  it('uses the accepted source revision even when Apply precedes queued dispatch', async () => {
    const { f, scheduler, admit, apply } = setup(wrap('return {completed: inputs.value * 2};'));
    const before = admit(21);
    apply(schedulerSnapshot(f.identity.huddleId, wrap('return {completed: inputs.value * 3};')));
    const after = admit(21);
    await scheduler.drain();
    expect(invocations(f, before.execution.id, 'result')[0]!.inputs).toEqual({ value: 42 });
    expect(invocations(f, after.execution.id, 'result')[0]!.inputs).toEqual({ value: 63 });
  });

  it('executes bounded feedback with new workers and exits on the declared condition', async () => {
    const { f, scheduler, admit } = setup(
      wrap('return {completed: {complete:inputs.value.count >= 2, count:inputs.value.count + 1}};'),
      5,
    );
    const event = admit({ complete: false, count: 0 });
    await scheduler.drain();
    expect(f.ledger.executions.get(event.execution.id).state).toBe('completed');
    expect(invocations(f, event.execution.id, 'worker').map((record) => record.iteration)).toEqual([
      0, 1, 2,
    ]);
    expect(invocations(f, event.execution.id, 'result').map((record) => record.inputs)).toEqual([
      { value: { complete: false, count: 1 } },
      { value: { complete: false, count: 2 } },
      { value: { complete: true, count: 3 } },
    ]);
  });

  it('records round exhaustion as failure, cancels descendants and never runs an extra iteration', async () => {
    const { f, scheduler, admit } = setup(
      wrap('return {completed: {complete:false, count:inputs.value.count + 1}};'),
      2,
    );
    const event = admit({ complete: false, count: 0 });
    await scheduler.drain();
    expect(f.ledger.executions.get(event.execution.id)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('2-round limit'),
    });
    expect(invocations(f, event.execution.id, 'worker')).toHaveLength(2);
    expect(f.ledger.page('emissions', { state: 'pending' })).toHaveLength(0);
    expect(scheduler.hasLiveWorkers).toBe(false);
  });

  it('retains script failure without dispatching a success readout', async () => {
    const { f, scheduler, admit } = setup(wrap('throw new Error("fixture failure");'));
    const event = admit(21);
    await scheduler.drain();
    expect(f.ledger.executions.get(event.execution.id)).toMatchObject({
      state: 'failed',
      error: 'fixture failure',
    });
    expect(invocations(f, event.execution.id, 'result')).toHaveLength(0);
  });

  it('interrupts a running CPU-bound worker and cancels queued roots instead of replaying them', async () => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { f, scheduler, admit } = setup(
      wrap('process.stdout.write("entered-loop"); while(true) {}'),
      undefined,
      {
        log: (_id, _stream, text) => {
          if (text.includes('entered-loop')) entered();
        },
      },
    );
    const running = admit(1);
    const queued = admit(2);
    const draining = scheduler.drain();
    await ready;
    await scheduler.halt('interrupted', 'User interrupted');
    await draining;
    expect(f.ledger.executions.get(running.execution.id).state).toBe('interrupted');
    expect(f.ledger.executions.get(queued.execution.id).state).toBe('cancelled');
    expect(scheduler.hasLiveWorkers).toBe(false);
    const control = f.ledger.activations.current();
    f.ledger.activations.setIntent(control.generation, 'armed', false);
    await scheduler.drain();
    expect(invocations(f, queued.execution.id)).toHaveLength(0);
  });
});
