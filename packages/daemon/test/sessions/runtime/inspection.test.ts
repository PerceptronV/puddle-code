import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sessionRuntimeInspectionSchema, type RuntimeState } from '@puddle/shared';
import { inspectSessionRuntime } from '../../../src/sessions/runtime/inspection.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { runtimeRelease } from '../../helpers/runtime-release.js';
import { resolveInstalledRuntimeRelease } from '../../../src/runtime/lifecycle/release.js';

describe('runtime restart review', () => {
  it('binds runtime, conversation, shell generations and exact selected release without output churn', async () => {
    const f = runtimeDatabase();
    const release = runtimeRelease(f.home);
    release.select();
    let selected = resolveInstalledRuntimeRelease(f.home);
    // Presentation consumes these fields; complete state validation belongs to runtime IPC.
    const state = {
      identity: f.launch.identity,
      state: 'running',
      persistence_pending: false,
      binding: { session_id: f.session.id, segment_id: f.binding.runtime_id },
      history: {
        current: { id: f.binding.runtime_id, agent_session_ref: null },
        pending_checkpoints: 0,
        gap: false,
      },
      terminals: [
        { term: 'agent', generation: randomUUID(), exit_code: null, pid: 100, cols: 80, rows: 24 },
      ],
    } as RuntimeState;
    const inspect = () =>
      sessionRuntimeInspectionSchema.parse(
        inspectSessionRuntime(f.session, f.binding, state, selected, null),
      );
    try {
      const original = inspect();
      expect(original.restart.available).toBe(true);
      expect(JSON.stringify(original)).not.toContain(f.home);
      expect(original.runtime?.terminals).toEqual([{ term: 'agent' }]);
      state.terminals[0]!.cols = 120;
      expect(inspect().restart).toEqual(original.restart);
      state.terminals.push({ ...state.terminals[0]!, term: 'shell-1', generation: randomUUID() });
      expect(inspect().restart).not.toEqual(original.restart);
      state.terminals.pop();
      const sameVersion = runtimeRelease(f.home);
      sameVersion.select();
      selected = resolveInstalledRuntimeRelease(f.home);
      expect(inspect().restart).not.toEqual(original.restart);
      state.history.current.id = randomUUID();
      expect(inspect().restart).toEqual({ available: false, reason: 'runtime_changed' });
      state.history.current.id = f.binding.runtime_id;
      state.persistence_pending = true;
      expect(inspect().restart).toEqual({ available: false, reason: 'state_not_saved' });
      state.persistence_pending = false;
      f.session.kind = 'agent';
      f.session.agent_session_ref = 'known';
      expect(inspect().restart).toEqual({ available: false, reason: 'conversation_unknown' });
    } finally {
      await f.reconciler.close();
      f.db.close();
    }
  });
});
