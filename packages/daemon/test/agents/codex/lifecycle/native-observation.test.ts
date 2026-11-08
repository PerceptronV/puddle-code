import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeBufferBudget } from '../../../../src/runtime/resources/budget.js';
import { codexBridgeFixture } from '../../../helpers/agents/codex.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const started = (threadId: string, id: string) => ({
  method: 'turn/started',
  params: { threadId, turn: { id, status: 'inProgress' } },
});
const completed = (threadId: string, id: string) => ({
  method: 'turn/completed',
  params: {
    threadId,
    turn: {
      id,
      status: 'completed',
      items: [{ type: 'agentMessage', phase: 'final_answer', text: 'answer' }],
    },
  },
});

it.each([false, true])(
  'preserves native scope within a batched frame (interrupted=%s)',
  async (interrupted) => {
    const f = await codexBridgeFixture();
    cleanups.push(() => f.close());
    f.socket.send(
      JSON.stringify([
        { id: 1, method: 'thread/start', params: {} },
        { id: 2, method: 'thread/start', params: {} },
        {
          method: 'fixture/batch',
          params: {
            messages: [
              { id: 1, result: { thread: { id: 'first' } } },
              started('first', 'one'),
              ...(interrupted ? [] : [completed('first', 'one')]),
              { id: 2, result: { thread: { id: 'second' } } },
              started('second', 'two'),
              completed('second', 'two'),
            ],
          },
        },
      ]),
    );
    await vi.waitFor(() => expect(f.events).toHaveLength(4));
    expect(f.events.map(({ event, bound }) => [event.event, event.agentSessionRef, bound])).toEqual(
      [
        ['started', 'first', 'first'],
        [interrupted ? 'interrupted' : 'completed', 'first', 'first'],
        ['started', 'second', 'second'],
        ['completed', 'second', 'second'],
      ],
    );
    expect(f.unavailable()).toBe(false);
    expect(f.gaps).toEqual([]);
    const origin = {
      turn: 1,
      huddle: { huddleId: 'e'.repeat(32), executionId: randomUUID(), operationId: randomUUID() },
    };
    expect(f.resource.control!.nativeTurnEvents).toBe(true);
    expect(
      await f.resource.control!.ask('question', new AbortController().signal, undefined, origin),
    ).toBe('answer');
    expect(
      f.events.slice(-2).map(({ event, bound }) => [event.event, event.automation, bound]),
    ).toEqual([
      ['started', origin, 'second'],
      ['completed', origin, 'second'],
    ]);
    expect(JSON.stringify(f.received)).not.toContain('puddlang:');
  },
);

it('resumes a partially observed native batch without repeating earlier messages after capacity returns', async () => {
  const budget = new RuntimeBufferBudget({ bytes: 64 * 1024 * 1024, count: 1000 });
  let denied = 0;
  const f = await codexBridgeFixture({
    reserve: (bytes) => (bytes === denied ? null : budget.reserve(bytes)),
  });
  cleanups.push(async () => {
    await f.close();
    expect(budget.usedBytes).toBe(0);
  });
  denied =
    4 *
      Buffer.byteLength(
        JSON.stringify({
          nonce: f.nonce,
          event: 'session_start',
          agent_session_ref: 'second',
          cwd: f.directory,
          source: 'clear',
        }),
      ) +
    512;
  f.socket.send(
    JSON.stringify([
      { id: 1, method: 'thread/start', params: {} },
      { id: 2, method: 'thread/start', params: {} },
      {
        method: 'fixture/batch',
        params: {
          messages: [
            { id: 1, result: { thread: { id: 'first' } } },
            started('first', 'one'),
            completed('first', 'one'),
            { id: 2, result: { thread: { id: 'second' } } },
            started('second', 'two'),
            completed('second', 'two'),
          ],
        },
      },
    ]),
  );
  await vi.waitFor(() => expect(f.events).toHaveLength(2));
  expect(f.received).toEqual([]);
  denied = 0;
  await vi.waitFor(() => expect(f.events).toHaveLength(4));
  expect(
    f.signals.filter((signal) => 'state' in signal && signal.state === 'working'),
  ).toHaveLength(2);
  expect(f.signals.filter((signal) => 'event' in signal)).toHaveLength(2);
  expect(f.unavailable()).toBe(false);
});
