import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { AgentNativeTurn } from '@puddle/shared';
import { InteractiveControl } from '../../../src/agents/interactive/control.js';
import { RetiredInteractiveTurns } from '../../../src/agents/interactive/retired-turns.js';
import type { RuntimeByteAllowance } from '../../../src/runtime/resources/budget.js';
function fixture(allowance?: RuntimeByteAllowance) {
  const events: AgentNativeTurn[] = [],
    write = vi.fn<(data: string) => void>();
  const gap = vi.fn();
  const control = new InteractiveControl(
    write,
    '\x1b',
    false,
    (event) => events.push(event),
    gap,
    allowance,
  );
  const identity = { nonce: randomUUID(), agent_session_ref: randomUUID(), turn_id: randomUUID() };
  control.lifecycle(identity.agent_session_ref, false);
  const submitted = () => {
    const text = write.mock.calls.find(([data]) => data.startsWith('\x1b[200~'))![0].slice(6, -6);
    return {
      ...identity,
      turn_id: /\[puddle-turn:([0-9a-f-]{36})\]$/.exec(text)![1]!,
      prompt_hash: createHash('sha256').update(text).digest('hex'),
    };
  };
  return { events, control, identity, submitted, gap };
}
it('observes external native turns once, ignoring foreign identities and unmatched completion', () => {
  const f = fixture();
  try {
    f.control.signal({ ...f.identity, event: 'turn_complete', reply: 'unstarted' });
    f.control.signal({ ...f.identity, agent_session_ref: 'foreign', event: 'turn_start' });
    expect(f.events).toHaveLength(0);
    f.control.signal({ ...f.identity, event: 'turn_start' });
    f.control.signal({ ...f.identity, event: 'turn_start' });
    f.control.signal({ ...f.identity, event: 'turn_complete', reply: 'answer' });
    f.control.signal({ ...f.identity, event: 'turn_complete', reply: 'duplicate' });
    expect(f.events.map((event) => [event.event, event.automated, event.reply])).toEqual([
      ['started', false, undefined],
      ['completed', false, 'answer'],
    ]);
  } finally {
    f.control.dispose();
  }
});
it.each(['human', 'switch', 'abort', 'timeout'] as const)(
  'keeps a delayed acknowledgement after %s attributed to the ended ask',
  async (action) => {
    vi.useFakeTimers();
    const f = fixture(),
      abort = new AbortController();
    const context = {
      turn: 7,
      huddle: { huddleId: 'a'.repeat(32), executionId: randomUUID(), operationId: randomUUID() },
    };
    try {
      const asking = f.control.ask('question', abort.signal, undefined, context);
      const rejected = expect(asking).rejects.toThrow();
      const identity = f.submitted();
      if (action === 'human') f.control.input();
      else if (action === 'switch') {
        f.control.lifecycle('other-conversation', false);
        f.control.lifecycle(identity.agent_session_ref, false);
      } else if (action === 'abort') abort.abort();
      else await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      f.control.signal({ ...identity, event: 'turn_start' });
      f.control.signal({ ...identity, event: 'turn_complete', reply: 'too late' });
      expect(
        f.events.map(({ event, automated, automation }) => ({ event, automated, automation })),
      ).toEqual([
        { event: 'started', automated: true, automation: context },
        { event: 'interrupted', automated: true, automation: context },
      ]);
      expect(f.gap).not.toHaveBeenCalled();
    } finally {
      f.control.dispose();
      vi.useRealTimers();
    }
  },
);
it('reports attribution loss when retired-ask retention cannot reserve memory', async () => {
  const f = fixture({ reserve: () => null }),
    abort = new AbortController();
  try {
    const asking = f.control.ask('question', abort.signal, undefined, { turn: 1 });
    const rejected = expect(asking).rejects.toThrow();
    const identity = f.submitted();
    abort.abort();
    await rejected;
    f.control.signal({ ...identity, event: 'turn_start' });
    f.control.signal({ ...identity, event: 'turn_complete', reply: 'unknown attribution' });
    expect(f.gap).toHaveBeenCalledWith(identity.agent_session_ref, identity.turn_id);
    expect(f.events.every((event) => event.automated && !event.automation)).toBe(true);
  } finally {
    f.control.dispose();
  }
});
it('bounds retired attribution and releases its managed memory on disposal', () => {
  const release = vi.fn();
  const retired = new RetiredInteractiveTurns({ reserve: () => release });
  for (let n = 0; n < 65; n++) retired.remember({ id: String(n), ref: 'ref', hash: 'hash' });
  expect(retired.get('0')).toBeDefined();
  expect(retired.get('64')).toBeUndefined();
  expect(retired.incomplete).toBe(true);
  retired.close();
  expect(release).toHaveBeenCalledTimes(64);
});
it.each(['human', 'switch', 'abort'] as const)(
  'retains %s interruption and never reports the late completion as the previous ask',
  async (action) => {
    const f = fixture(),
      abort = new AbortController();
    try {
      const asking = f.control.ask('question', abort.signal),
        rejected = expect(asking).rejects.toThrow();
      const identity = f.submitted();
      f.control.signal({ ...identity, event: 'turn_start' });
      if (action === 'human') f.control.input();
      else if (action === 'switch') f.control.lifecycle('new-conversation', false);
      else abort.abort();
      await rejected;
      f.control.signal({ ...identity, event: 'turn_complete', reply: 'late' });
      expect(f.events.map((event) => [event.event, event.automated])).toEqual([
        ['started', true],
        ['interrupted', true],
      ]);
    } finally {
      f.control.dispose();
    }
  },
);
it('reports an exact automated completion before resolving the ask and treats missing replies as failure', async () => {
  const f = fixture();
  try {
    const ask = f.control.ask('question', new AbortController().signal),
      identity = f.submitted();
    f.control.signal({ ...identity, event: 'turn_start' });
    f.control.signal({ ...identity, event: 'turn_complete', reply: 'answer' });
    expect(f.events[1]).toMatchObject({ event: 'completed', automated: true, reply: 'answer' });
    expect(await ask).toBe('answer');
    f.control.signal({ ...f.identity, event: 'turn_start' });
    f.control.signal({ ...f.identity, event: 'turn_complete' });
    expect(f.events.at(-1)).toMatchObject({ event: 'failed', automated: false });
  } finally {
    f.control.dispose();
  }
});
