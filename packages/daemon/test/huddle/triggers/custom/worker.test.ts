import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { customTriggerSnapshot } from '../../../helpers/huddle/custom-trigger.js';
import { workerTestHarness } from '../../../helpers/huddle/worker.js';
import { prepareHuddleTriggerJob } from '../../../../src/huddle/definitions/worker.js';
const workers = workerTestHarness();
function job(source: string) {
  const snapshot = customTriggerSnapshot('a'.repeat(32), source, workers.stage);
  return prepareHuddleTriggerJob(
    snapshot,
    {
      id: randomUUID(),
      revision: snapshot.digest,
      appliedAt: Date.now(),
      worktree: workers.stage,
      variables: {},
      bindings: { source: { worktree: workers.stage } },
    },
    'source',
    randomUUID(),
    { after: 1 },
  );
}
it('bounds blocked startup and positively observes child termination', async () => {
  const handle = workers.start(
    job(`import {HuddleTrigger} from 'puddlang/huddle';
    export default HuddleTrigger({contract:'./node.json',async open(){await new Promise(()=>{});}});`),
    { timeoutMs: 500 },
  );
  await expect(handle.result).rejects.toThrow('deadline');
  await handle.exited;
});
it('keeps an opened idle subscription alive past startup deadline and freezes its settings/cursor', async () => {
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const handle = workers.start(
    job(`import {HuddleTrigger} from 'puddlang/huddle';
    export default HuddleTrigger({contract:'./node.json',async open(context,cursor){
      if(!Object.isFrozen(cursor)||!Object.isFrozen(context.parameters)||!Object.isFrozen(context.bindings)) throw new Error('Mutable trigger context');
      return {async close(){}};
    }});`),
    { timeoutMs: 1000, request: async () => null, opened },
  );
  let ended = false;
  void handle.result.then(
    () => {
      ended = true;
    },
    () => {
      ended = true;
    },
  );
  await ready;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(ended).toBe(false);
  handle.cancel('Fixture stop');
  await expect(handle.result).rejects.toThrow('Fixture stop');
  await handle.exited;
});
