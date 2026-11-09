import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  coreHuddleComponents,
  huddleAuthoringFiles,
  huddleDefinitionSchema,
  HUDDLE_RUNTIME_CAPABILITIES,
} from '@puddle/shared';
import {
  intervalDefinitions,
  requireHuddleFeatures,
} from '../../../src/runtime/huddle/triggers/definitions.js';
import { customTriggerDefinitions } from '../../../src/runtime/huddle/triggers/custom/definitions.js';
import { installHuddleTemplate } from '../../../src/huddle/templates/install.js';
import { captureHuddleDefinition } from '../../../src/huddle/definitions/capture.js';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { HuddleRevisionController } from '../../../src/runtime/huddle/control/revisions.js';
import { HuddleScheduler } from '../../../src/runtime/huddle/execution/scheduler.js';
import { admitManualHuddle } from '../../../src/runtime/huddle/control/manual.js';
import { inspectHuddleTriggers } from '../../../src/runtime/huddle/inspection/triggers.js';
import { huddleLedgerFixture } from '../../helpers/huddle/ledger.js';
import { invocations } from '../../helpers/huddle/graph.js';
import { workerTestHarness } from '../../helpers/huddle/worker.js';

const workers = workerTestHarness();
it('copies Run, Interval and Result into editable source while keeping host admission and real worker routing', async () => {
  const f = huddleLedgerFixture();
  let scheduler: HuddleScheduler | undefined;
  try {
    const worktree = realpathSync(f.home);
    const root = join(worktree, '.puddle/huddle', f.identity.huddleId);
    mkdirSync(root, { recursive: true });
    const graph = huddleDefinitionSchema.parse({
      format: 1,
      id: f.identity.huddleId,
      name: 'Local copies',
      nodes: [],
      edges: [],
    });
    for (const [id, builtin] of [
      ['run', 'puddle.trigger.manual'],
      ['tick', 'puddle.trigger.interval'],
      ['result', 'puddle.readout.result'],
    ] as const) {
      const installed = installHuddleTemplate(
        worktree,
        {
          project_id: f.identity.projectId,
          huddle_id: f.identity.huddleId,
          worktree,
          template: 'builtin',
          component: id,
          builtin: { component: builtin, version: 1 },
        },
        () => {},
      );
      graph.nodes.push({
        id,
        source: { kind: 'local', manifest: installed.manifest },
        parameters: id === 'tick' ? { intervalMs: { kind: 'literal', value: 1000 } } : {},
        concurrency: 1,
      });
      if (id !== 'result')
        graph.edges.push({
          id,
          from: { node: id, port: 'event' },
          to: { node: id === 'tick' ? 'result-tick' : 'result', port: 'value' },
        });
    }
    graph.nodes.push({ ...graph.nodes.find((node) => node.id === 'result')!, id: 'result-tick' });
    writeFileSync(
      join(root, 'nodes/run/run.ts'),
      `import {HuddleNode} from 'puddlang/huddle';
export default HuddleNode({contract:'./node.json', async run({inputs,emit}) {
  await emit('event', {adapted: inputs.event}); return {};
}});`,
    );
    writeFileSync(join(root, 'huddle.json'), JSON.stringify(graph));
    const snapshot = await captureHuddleDefinition(
      worktree,
      f.identity.huddleId,
      coreHuddleComponents,
    );
    expect(snapshot.diagnostics, JSON.stringify(snapshot.diagnostics)).toEqual([]);
    const { hostTriggerScripts: _, ...old } = HUDDLE_RUNTIME_CAPABILITIES;
    expect(() => requireHuddleFeatures(snapshot, old)).toThrow('local host-trigger');
    requireHuddleFeatures(snapshot, HUDDLE_RUNTIME_CAPABILITIES);
    const store = new HuddleRevisionStore(f.home, f.identity.runtimeId, f.identity.huddleId);
    const revisions = new HuddleRevisionController(f.ledger, store);
    const { activation } = revisions.apply(
      snapshot,
      { id: randomUUID(), worktree, variables: {}, bindings: {} },
      0,
    );
    f.ledger.activations.setIntent(1, 'armed', false);
    expect(customTriggerDefinitions(snapshot, activation)).toEqual([]);
    const now = Date.now();
    f.ledger.intervals.synchronise(
      activation,
      intervalDefinitions(snapshot, activation),
      now - 1000,
    );
    expect(
      inspectHuddleTriggers(
        f.ledger,
        store,
        {
          runtimeId: f.identity.runtimeId,
          incarnation: randomUUID(),
          generation: f.ledger.activations.current().generation,
          activationId: activation.id,
        },
        true,
        null,
      ).sources.find((source) => source.node === 'tick')?.health,
    ).toBe('ready');
    const tick = f.ledger.intervals.admit('tick', graph.execution, now)!;
    const manual = admitManualHuddle(f.ledger, store, 'run', randomUUID(), 'custom input');
    scheduler = new HuddleScheduler(f.ledger, revisions, {
      nodePath: process.execPath,
      entryPath: join(workers.stage, 'daemon/huddle/runner.js'),
    });
    await scheduler.drain();
    expect(f.ledger.executions.get(manual.execution.id).state).toBe('completed');
    expect(invocations(f, manual.execution.id, 'run')[0]!.inputs).toEqual({
      event: 'custom input',
    });
    expect(invocations(f, manual.execution.id, 'result')[0]!.inputs).toEqual({
      value: { adapted: 'custom input' },
    });
    expect(f.ledger.executions.get(tick.execution.id).state).toBe('completed');
    expect(invocations(f, tick.execution.id, 'tick')).toHaveLength(1);
    expect(invocations(f, tick.execution.id, 'result-tick')[0]!.inputs).toEqual({
      value: f.ledger.executions.event(tick.execution.id).data,
    });
    expect(f.ledger.page('operations').every((row) => row.state === 'completed')).toBe(true);
  } finally {
    await scheduler?.halt('stopped', 'Fixture cleanup');
    f.cleanup();
  }
});

it('installs and executes the shipped conditional flow without mixing roots or invoking the unselected branch', async () => {
  const f = huddleLedgerFixture();
  let scheduler: HuddleScheduler | undefined;
  try {
    const worktree = realpathSync(f.home);
    const root = join(worktree, '.puddle/huddle', f.identity.huddleId);
    mkdirSync(root, { recursive: true });
    const graph = JSON.parse(huddleAuthoringFiles()['examples/flow.json']!);
    graph.id = f.identity.huddleId;
    writeFileSync(join(root, 'huddle.json'), JSON.stringify(graph));
    for (const template of ['transform', 'format-text', 'condition', 'merge', 'join'] as const)
      installHuddleTemplate(
        worktree,
        {
          project_id: f.identity.projectId,
          huddle_id: f.identity.huddleId,
          worktree,
          template,
          component: template,
        },
        () => {},
      );
    const snapshot = await captureHuddleDefinition(
      worktree,
      f.identity.huddleId,
      coreHuddleComponents,
    );
    expect(snapshot.diagnostics).toEqual([]);
    const store = new HuddleRevisionStore(f.home, f.identity.runtimeId, f.identity.huddleId);
    const revisions = new HuddleRevisionController(f.ledger, store);
    revisions.apply(snapshot, { id: randomUUID(), worktree, variables: {}, bindings: {} }, 0);
    f.ledger.activations.setIntent(1, 'armed', false);
    scheduler = new HuddleScheduler(f.ledger, revisions, {
      nodePath: process.execPath,
      entryPath: join(workers.stage, 'daemon/huddle/runner.js'),
    });
    const inputs = [
      { complete: true, message: 'Ready' },
      { complete: false, message: 'Revise' },
    ];
    const runs = inputs.map((data) =>
      admitManualHuddle(f.ledger, store, 'run', randomUUID(), data),
    );
    const missing = admitManualHuddle(f.ledger, store, 'run', randomUUID(), {
      message: 'No decision',
    });
    await scheduler.drain();
    for (const [index, run] of runs.entries()) {
      expect(f.ledger.executions.get(run.execution.id).state).toBe('completed');
      expect(invocations(f, run.execution.id, 'merge')[0]!.inputs).toEqual({
        [index === 0 ? 'left' : 'right']: inputs[index],
      });
      expect(invocations(f, run.execution.id, 'merge')).toHaveLength(1);
      expect(invocations(f, run.execution.id, 'join')).toHaveLength(1);
      expect(invocations(f, run.execution.id, 'result').map((row) => row.inputs)).toEqual([
        { value: { left: inputs[index], right: `Message: ${inputs[index]!.message}` } },
      ]);
    }
    expect(f.ledger.executions.get(missing.execution.id)).toMatchObject({ state: 'failed' });
    expect(invocations(f, missing.execution.id, 'result')).toHaveLength(0);
    expect(scheduler.hasLiveWorkers).toBe(false);
  } finally {
    await scheduler?.halt('stopped', 'Fixture cleanup');
    f.cleanup();
  }
});
