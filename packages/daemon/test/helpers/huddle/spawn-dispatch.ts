import { spawnOwnerFixture } from './spawn-owner.js';
import { HuddleAgentDispatcher } from '../../../src/huddle/operations/dispatch/service.js';
import { HuddleAgentTurns } from '../../../src/huddle/operations/turns/service.js';
import { HuddleTurnStore } from '../../../src/huddle/operations/turns/store.js';

export async function spawnDispatcherFixture(edit?: Parameters<typeof spawnOwnerFixture>[1]) {
  const f = await spawnOwnerFixture(true, edit);
  const turns = new HuddleAgentTurns(f.deps.turns, new HuddleTurnStore(f.db));
  let dispatcher = new HuddleAgentDispatcher({ ...f, turns });
  dispatcher.start();
  return {
    ...f,
    get dispatcher() {
      return dispatcher;
    },
    replace(spawns = f.spawns) {
      dispatcher = new HuddleAgentDispatcher({ ...f, turns, spawns });
      dispatcher.start();
    },
    async outcome() {
      const reply = await f.huddle.request({ t: 'records', collection: 'executions', after: 0 });
      if (reply.t !== 'records') throw new Error('No execution records');
      return reply.rows.map((row) => JSON.parse(row.body).state);
    },
    async spawnRecord() {
      const reply = await f.huddle.request({ t: 'spawn-page', after: 0 });
      if (reply.t !== 'spawn-page') throw new Error('No spawn records');
      return reply.page.records[0]?.operation;
    },
    async close() {
      await dispatcher.close();
      for (const row of f.db.prepare('SELECT intent FROM huddle_runtime_spawns').all() as {
        intent: string;
      }[]) {
        const { scope, request } = JSON.parse(row.intent);
        try {
          await f.spawns.cancel(scope, request, () => true);
        } catch {
          /* Isolated fixture child tracking fences unresolved processes. */
        }
      }
      await f.close();
    },
  };
}
