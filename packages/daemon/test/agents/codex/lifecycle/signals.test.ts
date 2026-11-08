import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LifecycleLaunchContext } from '../../../../src/agents/adapter.js';
import { RuntimeBufferBudget } from '../../../../src/runtime/resources/budget.js';
import { CodexSignalQueue } from '../../../../src/agents/codex/lifecycle/signals.js';
import {
  inspectMessages,
  clearPending,
  inspectRequest,
  type PendingRequest,
} from '../../../../src/agents/codex/lifecycle/observations.js';

afterEach(() => vi.unstubAllGlobals());
function context() {
  return {
    signalUrl: 'http://localhost/agent-signal',
    reportLifecycleUnavailable: vi.fn(),
  } as unknown as LifecycleLaunchContext;
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Codex bounded identity delivery', () => {
  it('delivers trusted runtime signals synchronously and fences refused identity without an HTTP fallback', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const ctx = { ...context(), receiveSignal: vi.fn(() => true) };
    const budget = new RuntimeBufferBudget({ bytes: 10000, count: 8 });
    const queue = new CodexSignalQueue(ctx, budget);
    const signal = {
      nonce: 'n'.repeat(32),
      event: 'session_start',
      agent_session_ref: 'native',
      cwd: '/work',
      source: 'startup',
    };
    expect(queue.enqueue(JSON.stringify(signal), true)).toBe(true);
    expect(ctx.receiveSignal).toHaveBeenCalledExactlyOnceWith(signal);
    expect(budget.usedBytes).toBe(0);
    ctx.receiveSignal.mockReturnValue(false);
    expect(queue.enqueue(JSON.stringify({ ...signal, agent_session_ref: 'refused' }), true)).toBe(
      true,
    );
    expect(queue.available).toBe(false);
    expect(ctx.reportLifecycleUnavailable).toHaveBeenCalledOnce();
    expect(queue.enqueue(JSON.stringify(signal), true)).toBe(false);
    await queue.close();
    expect(fetch).not.toHaveBeenCalled();
    expect(budget.usedBytes).toBe(0);
  });
  it('coalesces waiting status but keeps every identity transition in order', async () => {
    const hold = gate();
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(String(init.body));
        if (sent.length === 1) await hold.promise;
        return new Response();
      }),
    );
    const budget = new RuntimeBufferBudget({ bytes: 10000, count: 8 });
    const ctx = context();
    const queue = new CodexSignalQueue(ctx, budget);
    queue.enqueue('identity-one', true);
    for (let i = 0; i < 100; i++) expect(queue.enqueue(`status-${i}`, false)).toBe(true);
    queue.enqueue('identity-two', true);
    queue.enqueue('final-status', false);
    expect(budget.usedCount).toBe(4);
    hold.resolve();
    await queue.settled;
    expect(sent).toEqual(['identity-one', 'status-99', 'identity-two', 'final-status']);
    expect(budget.usedBytes).toBe(0);
    expect(ctx.reportLifecycleUnavailable).not.toHaveBeenCalled();
  });
  it('marks refused identity delivery unavailable without fabricating success, retaining in-flight bytes until settlement', async () => {
    const hold = gate();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await hold.promise;
        return new Response();
      }),
    );
    const budget = new RuntimeBufferBudget({ bytes: 10000, count: 1 });
    const ctx = context();
    const queue = new CodexSignalQueue(ctx, budget);
    expect(queue.enqueue('one', true)).toBe(true);
    expect(queue.enqueue('two', true)).toBe(false);
    expect(ctx.reportLifecycleUnavailable).toHaveBeenCalledOnce();
    expect(budget.usedCount).toBe(1);
    expect(queue.enqueue('later', false)).toBe(false);
    hold.resolve();
    await queue.settled;
    expect(budget.usedCount).toBe(0);
  });
  it('bounds unanswered exact requests and releases them on response-independent teardown', () => {
    const budget = new RuntimeBufferBudget({ bytes: 10000, count: 1 });
    const pending = new Map<string, PendingRequest>();
    expect(inspectRequest([{ id: 1, method: 'thread/start' }], pending, '/repo', budget)).toBe(
      true,
    );
    expect(() =>
      inspectRequest([{ id: 1, method: 'thread/fork' }], pending, '/repo', budget),
    ).toThrow('identity');
    expect(inspectRequest([{ id: 2, method: 'thread/start' }], pending, '/repo', budget)).toBe(
      false,
    );
    expect(pending.size).toBe(1);
    clearPending(pending);
    expect(budget.usedBytes).toBe(0);
  });
});

it('retries a whole unsent identity batch without partial requests, ref changes or HTTP replay', async () => {
  const pending = new Map<string, PendingRequest>();
  const one = new RuntimeBufferBudget({ bytes: 10000, count: 1 });
  expect(
    inspectRequest(
      [
        { id: 1, method: 'thread/start' },
        { id: 2, method: 'thread/start' },
      ],
      pending,
      '/repo',
      one,
    ),
  ).toBe(false);
  expect(pending.size).toBe(0);
  expect(one.usedCount).toBe(0);
  const requests = new RuntimeBufferBudget({ bytes: 10000, count: 10 });
  expect(
    inspectRequest(
      [
        { id: 1, method: 'thread/start' },
        { id: 2, method: 'thread/start' },
      ],
      pending,
      '/repo',
      requests,
    ),
  ).toBe(true);
  const owner = new RuntimeBufferBudget({ bytes: 5000, count: 10 });
  const occupied = owner.reserve(3500)!;
  const budget = new RuntimeBufferBudget({ bytes: 10000, count: 10 }, owner);
  const ctx = context();
  const queue = new CodexSignalQueue(ctx, budget);
  const state = { activeRef: null as string | null, queue: Promise.resolve(), delivery: queue };
  const send = vi.fn(async () => new Response());
  vi.stubGlobal('fetch', send);
  const messages = [
    { id: 1, result: { thread: { id: 'first' } } },
    { id: 2, result: { thread: { id: 'second' } } },
  ];
  expect(inspectMessages(messages, pending, ctx, state)).toBe(false);
  expect(pending.size).toBe(2);
  expect(state.activeRef).toBeNull();
  expect(send).not.toHaveBeenCalled();
  expect(budget.usedBytes).toBe(0);
  occupied();
  expect(inspectMessages(messages, pending, ctx, state)).toBe(true);
  await state.queue;
  expect(send).toHaveBeenCalledTimes(2);
  expect(pending.size).toBe(0);
  expect(state.activeRef).toBe('second');
  expect(owner.usedBytes).toBe(0);
});
