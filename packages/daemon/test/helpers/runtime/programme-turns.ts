import { randomUUID } from 'node:crypto';
import { puddlangStartSchema } from '@puddle/shared';
import { ProgrammeTurnStore } from '../../../src/puddlang/runtime-turn-store.js';
import { PuddlangStore } from '../../../src/puddlang/store.js';
import { runtimeDatabase } from '../runtime-database.js';

export function programmeTurnFixture() {
  const f = runtimeDatabase('headless');
  f.db
    .prepare("UPDATE runtime_bindings SET state = 'running' WHERE runtime_id = ?")
    .run(f.binding.runtime_id);
  const runs = new PuddlangStore(f.db);
  const run = runs.create(
    f.profile.id,
    puddlangStartSchema.parse({
      id: randomUUID(),
      source: 'export default null;',
    }),
  ).run;
  const operations = new ProgrammeTurnStore(f.db);
  const observations = f.reconciler.observations;
  const scope = (operationId: number) => ({ runId: run.id, operationId, profileId: f.profile.id });
  const reserve = (operationId: number) =>
    operations.reserve(
      scope(operationId),
      f.binding.runtime_id,
      { session_id: f.session.id, segment_id: f.binding.active_segment_id! },
      null,
      0,
    );
  const save = (turn: number, reply = `reply-${turn}`) => {
    observations.saveTurn(f.binding, { turn, expected_ref: null, status: 'running' });
    observations.saveTurn(f.binding, { turn, expected_ref: null, status: 'completed', reply });
  };
  const consume = (turn: number) => operations.consume(scope(turn), f.binding.runtime_id, turn);
  return {
    ...f,
    operations,
    observations,
    runs,
    run,
    scope,
    reserve,
    save,
    consume,
    async close() {
      await f.reconciler.close();
      f.db.close();
    },
  };
}
