import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { coreHuddleComponents, huddleAuthoringFiles } from '@puddle/shared';
import { installHuddleTemplate } from '../../../src/huddle/templates/install.js';
import { captureHuddleDefinition } from '../../../src/huddle/definitions/capture.js';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { HuddleRevisionController } from '../../../src/runtime/huddle/control/revisions.js';
import { HuddleScheduler } from '../../../src/runtime/huddle/execution/scheduler.js';
import { admitManualHuddle } from '../../../src/runtime/huddle/control/manual.js';
import { huddleLedgerFixture } from '../../helpers/huddle/ledger.js';
import { invocations } from '../../helpers/huddle/graph.js';
import { workerTestHarness } from '../../helpers/huddle/worker.js';

const workers = workerTestHarness();
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
