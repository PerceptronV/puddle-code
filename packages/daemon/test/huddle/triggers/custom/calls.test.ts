import { afterEach, expect, it, vi } from 'vitest';
import { HuddleWorkerCalls } from '../../../../src/runtime/huddle/workers/calls.js';
afterEach(() => vi.restoreAllMocks());

it('keeps an acknowledged subscription alive beyond a script request budget with bounded monotonic requests', async () => {
  let now = 0,
    sequence = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const calls = new HuddleWorkerCalls((message) => {
    expect(message.sequence).toBe(++sequence);
    calls.receive({ type: 'reply', id: message.id, value: null });
  });
  calls.subscribe();
  for (let i = 0; i < 5000; i++) {
    if (i % 64 === 0) now += 1000;
    await calls.call({ kind: 'trigger-checkpoint', cursor: i });
    expect(calls.pendingCount).toBe(0);
  }
  expect(sequence).toBe(5000);
});

it('bounds subscription request rate and rejects all pending calls on disconnect', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const sent = vi.fn();
  const calls = new HuddleWorkerCalls(sent);
  calls.subscribe();
  const pending = Array.from({ length: 64 }, (_, i) =>
    calls.call({ kind: 'trigger-checkpoint', cursor: i }).catch((error) => error),
  );
  await expect(calls.call({ kind: 'trigger-checkpoint', cursor: 65 })).rejects.toThrow(
    'request limit',
  );
  expect(sent).toHaveBeenCalledTimes(64);
  calls.close(new Error('Fixture disconnected'));
  expect(
    (await Promise.all(pending)).every(
      (value) => value instanceof Error && value.message === 'Fixture disconnected',
    ),
  ).toBe(true);
  expect(calls.pendingCount).toBe(0);
});
