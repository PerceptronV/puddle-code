import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { RuntimeState } from '@puddle/shared';
import type { RuntimeBinding } from '../../../src/db/stores/runtimes.js';
import type { RuntimeControls } from '../../../src/runtime/controller/controls.js';
import { runtimeBindingIdentity } from '../../../src/runtime/transport/connections.js';
import { HostRuntimeRemoval } from '../../../src/host/removal/runtimes.js';

function fixture(count = 1) {
  let rows: RuntimeBinding[] = Array.from({ length: count }, () => ({
    runtime_id: randomUUID(),
    incarnation: randomUUID(),
    launch_id: randomUUID(),
    launch_fingerprint: 'a'.repeat(64),
    profile_id: '1111111111',
    project_id: '2222222222',
    launch_session_id: randomUUID(),
    active_session_id: randomUUID(),
    active_segment_id: randomUUID(),
    account_id: null,
    agent_type: null,
    canonical_worktree_path: '/fixture/work',
    conversation_id: null,
    build: '0.4.0',
    protocol_major: 1,
    protocol_minor: 0,
    release_path: '/fixture/bin/versions/0.4.0~first',
    state: 'running',
    event_cursor: 0,
    created_at: new Date().toISOString(),
    ended_at: null,
  }));
  const states = rows.map(
    (row) =>
      ({
        identity: runtimeBindingIdentity(row),
        build: row.build,
        protocol: { major: 1, minor: 0 },
        state: 'running',
        binding: { session_id: row.active_session_id, segment_id: row.active_segment_id },
        terminals: [{ term: 'agent', generation: randomUUID(), exit_code: null }],
        agent: null,
        persistence_pending: false,
        journal: { persistence_pending: false },
        history: {
          current: { id: row.active_segment_id, agent_session_ref: null },
          gap: false,
          pending_checkpoints: 0,
        },
        // Only inspection fields are needed here; real-owner tests exercise transport validation.
      }) as RuntimeState,
  );
  const requested = new Set<string>();
  const inspect = vi.fn<RuntimeControls['inspect']>(async (session) =>
    states.find((s) => s.binding?.session_id === session)!,
  );
  const stop = vi.fn<RuntimeControls['stop']>(async (session, _authorised, review) => {
    const state = states.find((s) => s.binding?.session_id === session)!;
    review?.(state);
    requested.add(state.identity.runtime_id);
    rows = rows.filter((row) => row.runtime_id !== state.identity.runtime_id);
  });
  const runtimes = {
    live: vi.fn(() => rows),
    get: (id: string) => rows.find((row) => row.runtime_id === id) ?? null,
    stopRequested: (id: string) => requested.has(id),
  };
  const removal = new HostRuntimeRemoval({ runtimes, controls: { inspect, stop } });
  return { rows, states, requested, inspect, stop, runtimes, removal };
}

it('retains unavailable owners and their pinned release references without sending a stop', async () => {
  const f = fixture();
  f.inspect.mockRejectedValue(new Error('Disconnected'));
  const review = await f.removal.review(() => true);
  expect(review.owners).toEqual([
    {
      id: f.rows[0]!.runtime_id,
      session: f.rows[0]!.active_session_id,
      version: '0.4.0',
      release: f.rows[0]!.release_path,
      terminals: null,
      stop: { reason: 'unavailable' },
    },
  ]);
  await f.removal.apply(review, 'retain', () => true);
  await expect(f.removal.apply(review, 'stop', () => true)).rejects.toThrow(/resolved/);
  expect(f.stop).not.toHaveBeenCalled();
});

it.each(['shell', 'placement', 'release', 'conversation', 'generation'])(
  'rejects changed %s before dispatching any stop',
  async (change) => {
    const f = fixture(2);
    const review = await f.removal.review(() => true);
    const state = f.states[1]!;
    if (change === 'shell')
      state.terminals.push({ ...state.terminals[0]!, term: 'shell-1', generation: randomUUID() });
    if (change === 'placement') f.rows[1]!.active_session_id = randomUUID();
    if (change === 'release') f.rows[1]!.release_path += '-replacement';
    if (change === 'conversation') state.history.current.agent_session_ref = 'new-conversation';
    if (change === 'generation') state.terminals[0]!.generation = randomUUID();
    await expect(f.removal.apply(review, 'stop', () => true)).rejects.toThrow(/changed/);
    expect(f.stop).not.toHaveBeenCalled();
  },
);

it('rechecks terminal impact inside the existing serial stop queue', async () => {
  const f = fixture();
  const review = await f.removal.review(() => true);
  f.stop.mockImplementationOnce(async (_session, _authority, check) => {
    f.states[0]!.terminals.push({ ...f.states[0]!.terminals[0]!, term: 'shell-1' });
    check!(f.states[0]!);
    throw new Error('Must not reach dispatch');
  });
  await expect(f.removal.apply(review, 'stop', () => true)).rejects.toThrow(/impact changed/);
  expect(f.requested.size).toBe(0);
});

it('does not resend a recorded uncertain stop when the same removal is repeated', async () => {
  const f = fixture();
  const review = await f.removal.review(() => true);
  f.stop.mockImplementationOnce(async (_session, _authority, check) => {
    check!(f.states[0]!);
    f.requested.add(f.rows[0]!.runtime_id);
    throw new Error('Lost reply');
  });
  await expect(f.removal.apply(review, 'stop', () => true)).rejects.toThrow('Lost reply');
  await expect(f.removal.apply(review, 'stop', () => true)).rejects.toThrow(/changed/);
  const pending = await f.removal.review(() => true);
  expect(pending.owners[0]!.stop).toEqual({ reason: 'stop_pending' });
  await expect(f.removal.apply(pending, 'stop', () => true)).rejects.toThrow(/resolved/);
  expect(f.stop).toHaveBeenCalledOnce();
});

it('requires fresh authority after review and before each stop', async () => {
  const f = fixture(2);
  let authorised = true;
  const review = await f.removal.review(() => authorised);
  const stop = f.stop.getMockImplementation()!;
  f.stop.mockImplementation(async (...args) => {
    await stop(...args);
    authorised = false;
  });
  await expect(f.removal.apply(review, 'stop', () => authorised)).rejects.toThrow(/authority/);
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.runtimes.live()).toHaveLength(1);
});

it('rejects unknown persistence state and a newly admitted runtime before stopping', async () => {
  const f = fixture();
  f.states[0]!.journal.persistence_pending = true;
  const review = await f.removal.review(() => true);
  expect(review.owners[0]!.stop).toEqual({ reason: 'unsaved' });
  await expect(f.removal.apply(review, 'stop', () => true)).rejects.toThrow(/resolved/);
  f.states[0]!.journal.persistence_pending = false;
  const fresh = await f.removal.review(() => true);
  f.rows.push({ ...f.rows[0]!, runtime_id: randomUUID() });
  await expect(f.removal.apply(fresh, 'stop', () => true)).rejects.toThrow(/changed/);
  expect(f.stop).not.toHaveBeenCalled();
});

it('bounds the review inventory before starting owner inspection', async () => {
  const f = fixture(1025);
  await expect(f.removal.review(() => true)).rejects.toThrow(/limit/);
  expect(f.inspect).not.toHaveBeenCalled();
});

it('keeps approval stable through output acknowledgement and terminal resize', async () => {
  const f = fixture();
  const review = await f.removal.review(() => true);
  f.states[0]!.binding!.through = 100;
  f.states[0]!.terminals[0]!.cols = 120;
  f.states[0]!.terminals[0]!.rows = 40;
  f.rows[0]!.event_cursor = 100;
  await f.removal.apply(review, 'stop', () => true);
  expect(f.stop).toHaveBeenCalledOnce();
});

it('drains every admitted inspection before returning an authority failure', async () => {
  const f = fixture(5);
  const gates: Array<() => void> = [];
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  f.inspect.mockImplementation(async (session) => {
    await new Promise<void>((resolve) => {
      gates.push(resolve);
      if (gates.length === 4) ready();
    });
    return f.states.find((state) => state.binding?.session_id === session)!;
  });
  let authorised = true;
  let settled = false;
  const pending = f.removal
    .review(() => authorised)
    .finally(() => {
      settled = true;
    });
  const result = expect(pending).rejects.toThrow(/authority/);
  await started;
  authorised = false;
  gates[0]!();
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  for (const release of gates) release();
  await result;
  expect(f.inspect).toHaveBeenCalledTimes(4);
});
