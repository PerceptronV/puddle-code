import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { agentNativeTurnSchema, type AgentNativeTurn } from '@puddle/shared';
import { HeadlessTurnObservation } from '../../../src/agents/headless/native-turn.js';
import { bridge, context, fixtures, ref, headlessCleanups } from '../../helpers/agents/headless.js';
import { waitFor } from '../../helpers/daemon-fixtures.js';

afterEach(async () => {
  for (const cleanup of headlessCleanups.splice(0).reverse()) await cleanup();
});
const origin = () => ({
  huddleId: 'a'.repeat(32),
  executionId: randomUUID(),
  operationId: randomUUID(),
});

it.each(fixtures)(
  '$name retains distinct exact command turns and immutable automation context',
  async (provider) => {
    const s = await bridge(provider.records, 0, 0, provider.driver(context));
    const admitted = { turn: 1, huddle: origin() },
      expected = structuredClone(admitted);
    expect(s.control.nativeTurnEvents).toBe(true);
    const first = s.control.ask('question', new AbortController().signal, undefined, admitted);
    admitted.turn = 99;
    expect(await first).toBe('answer');
    expect(
      await s.control.ask('follow up', new AbortController().signal, undefined, { turn: 2 }),
    ).toBe('answer');
    const events = s.events.map((event) => agentNativeTurnSchema.parse(event));
    expect(events.map((event) => [event.event, event.automation])).toEqual([
      ['started', expected],
      ['completed', expected],
      ['started', { turn: 2 }],
      ['completed', { turn: 2 }],
    ]);
    expect(events.every((event) => event.automated && event.agentSessionRef === ref)).toBe(true);
    expect(events[0]!.nativeTurnId).toMatch(/^command:[a-f0-9-]{36}$/);
    expect(events[0]!.nativeTurnId).toBe(events[1]!.nativeTurnId);
    expect(events[2]!.nativeTurnId).toBe(events[3]!.nativeTurnId);
    expect(events[0]!.nativeTurnId).not.toBe(events[2]!.nativeTurnId);
    expect(
      events.filter((event) => event.event === 'completed').map((event) => event.reply),
    ).toEqual(['answer', 'answer']);
    expect(s.gaps).toEqual([]);
  },
);

it('does not publish completion until native result and process exit have both arrived', async () => {
  const s = await bridge(fixtures[1].records, 0, 500);
  const asking = s.control.ask('question', new AbortController().signal);
  await waitFor(() => s.events.length === 1);
  expect(s.events[0]).toMatchObject({ event: 'started', automated: true });
  expect(s.events[0]!.automation).toBeUndefined();
  expect(s.control.ready).toBe(false);
  expect(await asking).toBe('answer');
  expect(s.events.map((event) => event.event)).toEqual(['started', 'completed']);
});

it.each([
  { records: fixtures[1].records, code: 1 },
  { records: [{ type: 'thread.started', thread_id: ref }], code: 0 },
  {
    records: [
      { type: 'thread.started', thread_id: ref },
      { type: 'turn.failed', error: { message: 'denied' } },
    ],
    code: 0,
  },
])(
  'retains failure instead of completion for invalid native outcome $code/$records',
  async ({ records, code }) => {
    const s = await bridge(records, code);
    await expect(s.control.ask('question', new AbortController().signal)).rejects.toThrow();
    expect(s.events.map((event) => event.event)).toEqual(['started', 'failed']);
    expect(agentNativeTurnSchema.parse(s.events[1]).error).toBeTruthy();
    expect(s.events[1]!.reply).toBeUndefined();
  },
);

it('retains cancellation origin even after the native result but before exit', async () => {
  const s = await bridge(fixtures[1].records, 0, 60_000),
    abort = new AbortController();
  const admitted = { turn: 3, huddle: origin() };
  const asking = s.control.ask('question', abort.signal, undefined, admitted);
  const rejected = expect(asking).rejects.toThrow('cancelled');
  await waitFor(() => s.events.length === 1);
  abort.abort();
  expect(s.control.ready).toBe(false);
  await rejected;
  expect(s.events.map((event) => [event.event, event.automation])).toEqual([
    ['started', admitted],
    ['interrupted', admitted],
  ]);
});

it('waits for conversation binding before publishing observations', async () => {
  let resolve!: () => void,
    binding = false;
  const ready = new Promise<void>((done) => {
    resolve = done;
  });
  const s = await bridge(fixtures[1].records, 0, 0, undefined, '', {
    bindConversation: async () => {
      binding = true;
      await ready;
    },
  });
  const asking = s.control.ask('question', new AbortController().signal);
  await waitFor(() => binding);
  expect(s.events).toEqual([]);
  expect(s.control.ready).toBe(false);
  resolve();
  expect(await asking).toBe('answer');
  expect(s.events.map((event) => event.event)).toEqual(['started', 'completed']);
});

it.each(['cancel', 'dispose', 'reject-binding'] as const)(
  'reports a gap when %s prevents binding instead of inventing a session scope',
  async (action) => {
    let resolve!: () => void,
      reject!: (error: Error) => void,
      binding = false;
    const ready = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const s = await bridge(fixtures[1].records, 0, 60_000, undefined, '', {
      bindConversation: async () => {
        binding = true;
        await ready;
      },
    });
    const abort = new AbortController();
    const asking = s.control.ask('question', abort.signal, undefined, { turn: 1 });
    const rejected = expect(asking).rejects.toThrow();
    await waitFor(() => binding);
    if (action === 'cancel') abort.abort();
    else if (action === 'dispose') await s.dispose();
    if (action === 'reject-binding') reject(new Error('Native identity could not be bound'));
    else resolve();
    await rejected;
    expect(s.events).toEqual([]);
    expect(s.gaps).toEqual([[ref, expect.stringMatching(/^command:/)]]);
    if (action === 'reject-binding') {
      expect(s.control.ready).toBe(false);
      await expect(s.control.ask('retry', new AbortController().signal)).rejects.toThrow(
        'not ready',
      );
    }
  },
);

it('bounds observation memory without blocking ordinary execution and releases the charge', () => {
  const events: AgentNativeTurn[] = [],
    gap = vi.fn(),
    release = vi.fn();
  for (const reserve of [() => null, () => release]) {
    const observation = new HeadlessTurnObservation(
      'id',
      { turn: 1 },
      (event) => events.push(event),
      gap,
      { reserve },
    );
    observation.identify(ref);
    observation.start();
    observation.finish('answer');
    observation.close();
    observation.close();
  }
  expect(gap).toHaveBeenCalledExactlyOnceWith(ref, 'command:id');
  expect(events.map((event) => event.event)).toEqual(['started', 'completed']);
  expect(release).toHaveBeenCalledTimes(1);
});

it('refuses oversized native identities before retaining or binding them', async () => {
  const s = await bridge([{ type: 'thread.started', thread_id: 'x'.repeat(201) }]);
  await expect(s.control.ask('question', new AbortController().signal)).rejects.toThrow(
    'identity exceeds',
  );
  expect(s.bound).toEqual([]);
  expect(s.events).toEqual([]);
});

it('does not throw source observer errors into ordinary native execution', () => {
  const observation = new HeadlessTurnObservation(
    'id',
    undefined,
    () => {
      throw new Error('source unavailable');
    },
    () => {
      throw new Error('gap unavailable');
    },
    undefined,
  );
  observation.identify(ref);
  expect(() => observation.start()).not.toThrow();
  expect(() => observation.finish('reply')).not.toThrow();
  observation.close();
});
