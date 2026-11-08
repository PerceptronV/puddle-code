import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { agentNativeTurnSchema, type AgentNativeTurn } from '@puddle/shared';
import { CodexControl } from '../../../src/agents/codex/control.js';
import { RuntimeBufferBudget } from '../../../src/runtime/resources/budget.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(bytes = 32 * 1024 * 1024) {
  const allowance = new RuntimeBufferBudget({ bytes, count: 1000 });
  const events: AgentNativeTurn[] = [],
    sent: Array<Record<string, unknown>> = [];
  const gap = vi.fn();
  const control = new CodexControl(allowance, {
    reportNativeTurn: (event) => events.push(agentNativeTurnSchema.parse(event)),
    reportNativeTurnGap: gap,
  });
  control.connect((message) => sent.push(message));
  control.bind('thread');
  cleanups.push(() => {
    control.disconnect();
    expect(allowance.usedBytes).toBe(0);
  });
  return { control, events, sent, gap, allowance };
}
const started = (id: string, threadId = 'thread') => ({
  method: 'turn/started',
  params: { threadId, turn: { id, status: 'inProgress' } },
});
const item = (id: string, text: string, phase = 'final_answer') => ({
  method: 'item/completed',
  params: { threadId: 'thread', turnId: id, item: { type: 'agentMessage', text, phase } },
});
const completed = (id: string, status = 'completed') => ({
  method: 'turn/completed',
  params: { threadId: 'thread', turn: { id, status, items: [] } },
});
const origin = () => ({
  turn: 7,
  huddle: { huddleId: 'd'.repeat(32), executionId: randomUUID(), operationId: randomUUID() },
});

it('retains human native turns once with exact identities and excludes commentary/side threads', () => {
  const f = fixture();
  f.control.server(started('side', 'other'));
  f.control.server(started('native'));
  f.control.server(started('native'));
  f.control.server(item('native', 'thinking', 'commentary'));
  f.control.server(item('other', 'wrong'));
  f.control.server(item('native', 'answer'));
  f.control.server(completed('native'));
  f.control.server(completed('native'));
  expect(
    f.events.map((event) => [event.event, event.nativeTurnId, event.automated, event.reply]),
  ).toEqual([
    ['started', 'native', false, undefined],
    ['completed', 'native', false, 'answer'],
  ]);
  expect(f.gap).not.toHaveBeenCalled();
});

it.each(['before', 'after', 'no-start'] as const)(
  'correlates automation when native completion arrives %s the RPC acknowledgement',
  async (timing) => {
    const f = fixture(),
      admitted = origin(),
      expected = structuredClone(admitted);
    const ask = f.control.ask('question', new AbortController().signal, undefined, admitted);
    admitted.turn = 99;
    const ack = { id: f.sent[0]!.id, result: { turn: { id: 'native', status: 'inProgress' } } };
    if (timing === 'after') f.control.server(ack);
    if (timing !== 'no-start') f.control.server(started('native'));
    f.control.server(item('native', 'answer'));
    f.control.server(completed('native'));
    if (timing !== 'after') {
      expect(f.events).toEqual([]);
      f.control.server(ack);
    }
    expect(await ask).toBe('answer');
    expect(f.events.map((event) => [event.event, event.automated, event.automation])).toEqual([
      ['started', true, expected],
      ['completed', true, expected],
    ]);
  },
);

it.each([false, true])(
  'preserves cancellation attribution (acknowledged=%s), rejecting late success',
  async (acknowledged) => {
    const f = fixture(),
      abort = new AbortController(),
      admitted = origin();
    const ask = f.control.ask('question', abort.signal, undefined, admitted);
    const rejected = expect(ask).rejects.toThrow('cancelled');
    const ack = { id: f.sent[0]!.id, result: { turn: { id: 'native', status: 'inProgress' } } };
    f.control.server(started('native'));
    if (acknowledged) f.control.server(ack);
    abort.abort();
    await rejected;
    f.control.server(item('native', 'late'));
    f.control.server(completed('native'));
    if (!acknowledged) f.control.server(ack);
    expect(f.events.map((event) => [event.event, event.automation])).toEqual([
      ['started', admitted],
      ['interrupted', admitted],
    ]);
  },
);

it('never donates a human turn to an interrupted unacknowledged ask', async () => {
  const f = fixture(),
    admitted = origin();
  const ask = f.control.ask('question', new AbortController().signal, undefined, admitted);
  const rejected = expect(ask).rejects.toThrow('Human');
  f.control.server(started('automation'));
  f.control.client({ method: 'turn/start', params: { threadId: 'thread' } });
  await rejected;
  f.control.server(started('human'));
  f.control.server(item('human', 'human answer'));
  f.control.server(completed('human'));
  expect(f.events).toEqual([]);
  f.control.server({
    id: f.sent[0]!.id,
    result: { turn: { id: 'automation', status: 'inProgress' } },
  });
  expect(f.events.map((event) => [event.nativeTurnId, event.event, event.automated])).toEqual([
    ['automation', 'started', true],
    ['automation', 'interrupted', true],
    ['human', 'started', false],
    ['human', 'completed', false],
  ]);
});

it('ends old native scope before a switch and does not publish late acknowledgement into the replacement', async () => {
  const f = fixture();
  f.control.server(started('human'));
  f.control.bind('next');
  expect(f.events.at(-1)).toMatchObject({ event: 'interrupted', agentSessionRef: 'thread' });
  f.control.bind('thread');
  const ask = f.control.ask('question', new AbortController().signal, undefined, origin());
  const rejected = expect(ask).rejects.toThrow('changed');
  f.control.server(started('pending'));
  f.control.bind('next');
  await rejected;
  f.control.server({ id: f.sent[0]!.id, result: { turn: { id: 'pending' } } });
  expect(f.events).toHaveLength(2);
  expect(f.gap).toHaveBeenCalled();
});

it('reports missing admission, failed native outcomes and oversized replies without fabricating success', () => {
  const f = fixture();
  f.control.server(completed('missing'));
  expect(f.gap).toHaveBeenCalledWith('thread', 'missing');
  f.control.server(started('failed'));
  f.control.server(completed('failed', 'failed'));
  f.control.server(started('huge'));
  f.control.server(item('huge', '界'.repeat(100_000)));
  expect(f.events.map((event) => event.event)).toEqual(['started', 'failed', 'started', 'failed']);
});

it.each(['rejected', 'malformed', 'returned-scope'] as const)(
  'keeps buffered attribution unknown after %s acknowledgement',
  async (mode) => {
    const f = fixture();
    const ask = f.control.ask('question', new AbortController().signal, undefined, origin());
    const rejected = expect(ask).rejects.toThrow();
    if (mode === 'returned-scope') {
      f.control.bind('other');
      f.control.bind('thread');
    }
    f.control.server(started('unattributed'));
    f.control.server(item('unattributed', 'answer'));
    f.control.server(completed('unattributed'));
    expect(f.events).toEqual([]);
    f.control.server({
      id: f.sent[0]!.id,
      ...(mode === 'rejected'
        ? { error: { message: 'denied' } }
        : { result: { turn: { id: mode === 'malformed' ? '' : 'unattributed' } } }),
    });
    await rejected;
    expect(f.events.map((event) => [event.event, event.automated, event.automation])).toEqual([
      ['started', true, undefined],
      ['completed', true, undefined],
    ]);
    expect(f.gap).toHaveBeenCalled();
  },
);

it('keeps the ordinary ask result available when optional turn retention is refused', async () => {
  const f = fixture(8 * 1024 * 1024 + 16 * 1024);
  const ask = f.control.ask('question', new AbortController().signal, undefined, origin());
  f.control.server({ id: f.sent[0]!.id, result: { turn: { id: 'native', status: 'inProgress' } } });
  f.control.server(item('native', 'answer'));
  f.control.server(completed('native'));
  expect(await ask).toBe('answer');
  expect(f.events).toEqual([]);
  expect(f.gap).toHaveBeenCalled();
});

it('bounds abandoned observation context and marks later unattributed turns unknown after exhaustion', async () => {
  const f = fixture();
  for (let i = 0; i < 65; i++) {
    f.control.bind(`thread-${i}`);
    const abort = new AbortController();
    const ask = f.control.ask('question', abort.signal, undefined, origin());
    const rejected = expect(ask).rejects.toThrow();
    abort.abort();
    await rejected;
  }
  f.control.bind('thread');
  f.control.server(started('unknown'));
  f.control.server(item('unknown', 'answer'));
  f.control.server(completed('unknown'));
  expect(f.events.map((event) => [event.event, event.automated, event.automation])).toEqual([
    ['started', true, undefined],
    ['completed', true, undefined],
  ]);
  expect(f.gap).toHaveBeenCalled();
});
