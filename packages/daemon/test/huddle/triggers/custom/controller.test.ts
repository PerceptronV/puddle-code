import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HUDDLE_RUNTIME_CAPABILITIES } from '@puddle/shared';
import { huddleLedgerFixture } from '../../../helpers/huddle/ledger.js';
import {
  customTriggerSnapshot,
  fileTriggerSource,
} from '../../../helpers/huddle/custom-trigger.js';
import { workerTestHarness } from '../../../helpers/huddle/worker.js';
import { until } from '../../../helpers/huddle/controller.js';
import { HuddleRevisionStore } from '../../../../src/runtime/huddle/state/revisions.js';
import { HuddleRevisionController } from '../../../../src/runtime/huddle/control/revisions.js';
import { HuddleCustomTriggerController } from '../../../../src/runtime/huddle/triggers/custom/controller.js';
import { HuddleScheduler } from '../../../../src/runtime/huddle/execution/scheduler.js';
import type { HuddleDefinitionSnapshot } from '../../../../src/huddle/definitions/capture.js';
import { huddleRevisionDigest } from '../../../../src/huddle/definitions/revision.js';

const workers = workerTestHarness();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function fixture(
  source = fileTriggerSource,
  mutate?: (snapshot: HuddleDefinitionSnapshot) => void,
) {
  const f = huddleLedgerFixture();
  const snapshot = customTriggerSnapshot(f.identity.huddleId, source, f.home);
  mutate?.(snapshot);
  snapshot.files['huddle.json'] = JSON.stringify(snapshot.definition);
  snapshot.files['nodes/example/node.json'] = JSON.stringify(snapshot.components.source);
  snapshot.digest = huddleRevisionDigest(snapshot.files, snapshot.components);
  const store = new HuddleRevisionStore(f.home, f.identity.runtimeId, f.identity.huddleId);
  const revisions = new HuddleRevisionController(f.ledger, store);
  revisions.apply(
    snapshot,
    {
      id: randomUUID(),
      worktree: f.home,
      variables: {},
      bindings: Object.fromEntries(
        snapshot.definition.nodes
          .filter((node) => snapshot.components[node.id]!.parameters.worktree)
          .map((node) => [node.id, { worktree: f.home }]),
      ),
    },
    0,
  );
  f.ledger.activations.setIntent(1, 'armed', false);
  const options = {
    nodePath: process.execPath,
    entryPath: join(workers.stage, 'daemon/huddle/runner.js'),
  };
  const scheduler = new HuddleScheduler(f.ledger, revisions, options);
  const fatal = vi.fn(),
    changed = vi.fn();
  const controller = new HuddleCustomTriggerController(
    f.ledger,
    store,
    HUDDLE_RUNTIME_CAPABILITIES,
    options,
    () => {
      void scheduler.drain();
    },
    changed,
    fatal,
    () => {},
  );
  cleanups.push(async () => {
    controller.stop();
    await controller.settled();
    await scheduler.halt('stopped', 'cleanup');
    f.cleanup();
  });
  return { f, snapshot, store, revisions, controller, scheduler, fatal, changed };
}

it('runs a captured subscription, acknowledges routed events, closes resources and resumes from its retained cursor', async () => {
  const { f, controller, fatal } = fixture();
  await controller.refresh();
  await until(() => f.ledger.customTriggers.list()[0]?.health.state === 'ready');
  writeFileSync(join(f.home, 'input.json'), JSON.stringify({ id: 'one', value: 42 }));
  await until(() => f.ledger.page('executions', { state: 'completed' }).length === 1);
  await until(() => existsSync(join(f.home, 'ack')));
  expect(JSON.parse(readFileSync(join(f.home, 'ack'), 'utf8')).duplicate).toBe(false);
  controller.stop();
  await controller.settled();
  expect(controller.hasLiveWorkers).toBe(false);
  expect(readFileSync(join(f.home, 'closed'), 'utf8')).toBe('x');
  await controller.refresh();
  await until(() => readFileSync(join(f.home, 'opened'), 'utf8').trim().split('\n').length === 2);
  expect(readFileSync(join(f.home, 'opened'), 'utf8').trim().split('\n')).toEqual([
    'null',
    '"one"',
  ]);
  expect(f.ledger.page('executions')).toHaveLength(1);
  expect(fatal).not.toHaveBeenCalled();
});

it.each([
  ['gap', `await context.health({state:'gap',message:'Cursor expired',after:cursor});`],
  ['crash', `process.exit(1);`],
  ['invalid output', `await context.emit({id:'bad',port:'event',data:'wrong',nextCursor:1});`],
  ['request flood', `await Promise.all(Array.from({length:100},(_,i)=>context.checkpoint(i)));`],
  ['agent operation', `const {attach}=await import('puddlang'); await attach('some-agent');`],
] as const)(
  'retains a visible source gap after %s without failing the owner',
  async (_name, body) => {
    const { f, controller, fatal } = fixture(
      `import {HuddleTrigger} from 'puddlang/huddle'; export default HuddleTrigger({contract:'./node.json',async open(context,cursor){${body} return {async close(){}};}});`,
    );
    await controller.refresh();
    await until(() => f.ledger.customTriggers.list()[0]?.health.state === 'gap');
    await controller.settled();
    expect(controller.hasLiveWorkers).toBe(false);
    expect(f.ledger.page('executions')).toHaveLength(0);
    if (_name !== 'request flood') expect(f.ledger.customTriggers.list()[0]!.cursor).toBeNull();
    expect(fatal).not.toHaveBeenCalled();
  },
);

it('keeps a healthy subscription running when another captured source fails', async () => {
  const source = fileTriggerSource.replace(
    'const root=context.bindings.worktree;',
    "if(context.parameters.fail) throw new Error('Fixture source failed'); const root=context.bindings.worktree;",
  );
  const { f, controller, fatal } = fixture(source, (snapshot) => {
    snapshot.components.source!.parameters.fail = {
      schema: { type: 'boolean' },
      required: false,
      editor: 'boolean',
    };
    snapshot.definition.nodes.push({
      ...snapshot.definition.nodes[0]!,
      id: 'bad',
      parameters: {
        ...snapshot.definition.nodes[0]!.parameters,
        fail: { kind: 'literal', value: true },
      },
    });
    snapshot.components.bad = snapshot.components.source!;
    snapshot.definition.nodes.push({ ...snapshot.definition.nodes[1]!, id: 'bad-result' });
    snapshot.components['bad-result'] = snapshot.components.result!;
    snapshot.definition.edges.push({
      id: 'bad-result',
      from: { node: 'bad', port: 'event' },
      to: { node: 'bad-result', port: 'value' },
    });
  });
  await controller.refresh();
  await until(
    () =>
      f.ledger.customTriggers
        .list()
        .some((item) => item.node === 'bad' && item.health.state === 'gap') &&
      f.ledger.customTriggers
        .list()
        .some((item) => item.node === 'source' && item.health.state === 'ready'),
  );
  expect(controller.hasLiveWorkers).toBe(true);
  writeFileSync(join(f.home, 'input.json'), JSON.stringify({ id: 'surviving', value: 42 }));
  await until(() => f.ledger.page('executions', { state: 'completed' }).length === 1);
  expect(fatal).not.toHaveBeenCalled();
});
