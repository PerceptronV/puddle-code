import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_LIMITS, type RuntimeRetainedEvent } from '@puddle/shared';
import { RuntimeJournal } from '../../../src/runtime/state/journal.js';
import { RuntimeTurns } from '../../../src/runtime/execution/turns.js';

const journals: RuntimeJournal[] = [];
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close();
});
function fixture(maxBytes?: number) {
  const journal = new RuntimeJournal(
    '/unused',
    {
      runtime_id: randomUUID(),
      incarnation: randomUUID(),
      launch_id: randomUUID(),
      session_id: randomUUID(),
      profile_id: '1111111111',
      project_id: '2222222222',
      canonical_worktree_path: '/unused',
    },
    { write: async () => {}, ...(maxBytes ? { maxBytes } : {}) },
  );
  journals.push(journal);
  const events: RuntimeRetainedEvent[] = [];
  let cursor = 0;
  const turns = new RuntimeTurns(journal, (event, reservation) => {
    const retained = { ...event, cursor: ++cursor };
    reservation.append(retained);
    events.push(retained);
  });
  let resolve!: (reply: string) => void;
  let reject!: (error: Error) => void;
  const ask = vi.fn(
    (_prompt: string, _signal: AbortSignal) =>
      new Promise<string>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
  );
  const control = { ready: true, ask };
  const request = { turn: 1, expected_ref: 'native-ref', prompt: 'question' };
  return {
    journal,
    turns,
    events,
    control,
    ask,
    request,
    resolve: (value: string) => resolve(value),
    reject: (error: Error) => reject(error),
  };
}

describe('runtime turn admission and retention', () => {
  it('allows the first exact binding of a new conversation but interrupts a later switch', async () => {
    const s = fixture();
    s.turns.start(s.control, null, { ...s.request, expected_ref: null });
    s.turns.lifecycle({
      event: 'session_start',
      agent_session_ref: 'first-native',
      cwd: '/unused',
      source: 'startup',
    });
    expect(s.turns.state()?.status).toBe('running');
    s.turns.lifecycle({
      event: 'session_start',
      agent_session_ref: 'next-native',
      cwd: '/unused',
      source: 'clear',
    });
    s.resolve('late response');
    await Promise.resolve();
    expect(s.turns.result(1)).toMatchObject({ status: 'interrupted', expected_ref: null });
    expect(s.events).toHaveLength(2);
  });
  it('admits once, reserves its outcome and retains completion without a waiting controller', async () => {
    const s = fixture();
    expect(s.turns.start(s.control, 'native-ref', s.request).status).toBe('running');
    expect(() => s.turns.start(s.control, 'native-ref', s.request)).toThrow(/already admitted/);
    expect(() => s.turns.start(s.control, 'native-ref', { ...s.request, turn: 2 })).toThrow(
      /not ready/,
    );
    expect(s.ask).toHaveBeenCalledTimes(1);
    s.resolve('answer');
    await Promise.resolve();
    expect(s.turns.result(1)).toMatchObject({ status: 'completed', reply: 'answer' });
    expect(s.events.map((event) => event.t)).toEqual(['turn-started', 'turn-finished']);
    s.journal.acknowledge(2);
    expect(() => s.turns.start(s.control, 'native-ref', s.request)).toThrow(/already admitted/);
    expect(s.turns.result(1).reply).toBe('answer');
  });

  it('refuses stale conversation identity and insufficient outcome space before dispatch', () => {
    const s = fixture(1024);
    expect(() => s.turns.start(s.control, 'other-ref', s.request)).toThrow(/conversation changed/);
    expect(() => s.turns.start(s.control, 'native-ref', s.request)).toThrow(/retention/);
    expect(s.ask).not.toHaveBeenCalled();
    expect(s.turns.state()).toBeNull();
    expect(s.events).toEqual([]);
  });

  it('rejects stale cancellation and ignores late completion after cancellation or human takeover', async () => {
    const s = fixture();
    s.turns.start(s.control, 'native-ref', s.request);
    expect(() => s.turns.cancel(2)).toThrow(/unavailable/);
    s.turns.cancel(1);
    expect(s.ask.mock.calls[0]![1].aborted).toBe(true);
    s.resolve('late answer');
    await Promise.resolve();
    expect(s.turns.result(1)).toMatchObject({ status: 'cancelled' });
    expect(s.events).toHaveLength(2);
    s.turns.cancel(1);
    expect(s.events).toHaveLength(2);
    s.turns.start(s.control, 'native-ref', { ...s.request, turn: 2 });
    expect(() => s.turns.cancel(1)).toThrow(/unavailable/);
    s.turns.interrupt('Human input');
    s.reject(new Error('Late provider error'));
    await Promise.resolve();
    expect(s.turns.result(2)).toMatchObject({ status: 'interrupted', error: 'Human input' });
    expect(s.events).toHaveLength(4);
  });

  it('retains bounded failures and reserves enough for worst-case JSON escaping', async () => {
    const s = fixture();
    s.turns.start(s.control, 'native-ref', s.request);
    s.resolve('\0'.repeat(RUNTIME_LIMITS.turnReplyBytes));
    await Promise.resolve();
    expect(s.turns.result(1).status).toBe('completed');
    expect(Buffer.byteLength(JSON.stringify(s.events))).toBeLessThan(RUNTIME_LIMITS.journalBytes);
    s.journal.acknowledge(2);
    s.turns.start(s.control, 'native-ref', { ...s.request, turn: 2 });
    s.resolve('😀'.repeat(RUNTIME_LIMITS.turnReplyBytes / 2));
    await Promise.resolve();
    expect(s.turns.result(2)).toMatchObject({
      status: 'failed',
      error: 'Provider result exceeds its byte limit',
    });
  });

  it('retains synchronous provider exceptions as outcomes without making the turn replayable', () => {
    const s = fixture();
    s.ask.mockImplementationOnce(() => {
      throw new Error('Provider refused');
    });
    s.turns.start(s.control, 'native-ref', s.request);
    return Promise.resolve().then(() => {
      expect(s.turns.result(1)).toMatchObject({ status: 'failed', error: 'Provider refused' });
      expect(() => s.turns.start(s.control, 'native-ref', s.request)).toThrow(/already admitted/);
    });
  });
});
