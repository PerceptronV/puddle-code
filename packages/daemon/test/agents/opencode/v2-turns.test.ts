import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { OPENCODE_V2_TURNS_SOURCE } from '../../../src/agents/opencode/v2-turns.js';

async function fixture() {
  const plugin = await import(
    `data:text/javascript;base64,${Buffer.from(OPENCODE_V2_TURNS_SOURCE).toString('base64')}`
  );
  let active = 'selected';
  const signal = vi.fn(async () => {});
  const get = vi.fn(async () => ({
    id: 'answer',
    type: 'assistant',
    finish: 'stop',
    time: { completed: 1 },
    content: [
      { type: 'text', text: 'final answer' },
      { type: 'reasoning', text: 'private' },
    ],
  }));
  const turns = plugin.createTurns(
    { client: { session: { message: { get } } } },
    (ref: string) => ref === active,
    signal,
  );
  const event = (type: string, data: object = {}) =>
    turns.receive({ type: `session.${type}`, data: { sessionID: 'selected', ...data } });
  const prompt = async (id = 'input') => {
    const turn = randomUUID();
    const text = `question\n\n[puddle-turn:${turn}]`;
    await event('inbox.enqueued', {
      inboxID: id,
      item: { type: 'user', payload: { text: text + ' ' } },
    });
    return { turn, text };
  };
  return {
    signal,
    get,
    event,
    prompt,
    leave: () => {
      active = 'other';
      turns.reset();
    },
  };
}

it('correlates durable prompt admission, delivery, assistant step and final completion', async () => {
  const f = await fixture();
  const { turn, text } = await f.prompt();
  expect(f.signal).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'turn_start',
      turn_id: turn,
      prompt_hash: createHash('sha256').update(text).digest('hex'),
    }),
    'selected',
  );
  await f.event('step.started', { assistantMessageID: 'old-answer' });
  await f.event('execution.succeeded');
  expect(f.get).not.toHaveBeenCalled(); // The admitted prompt is still queued.
  await f.event('inbox.delivered', { inboxID: 'input' });
  await f.event('step.started', { assistantMessageID: 'answer' });
  await f.event('execution.succeeded');
  expect(f.get).toHaveBeenCalledWith(
    { sessionID: 'selected', messageID: 'answer' },
    expect.anything(),
  );
  expect(f.signal).toHaveBeenLastCalledWith(
    expect.objectContaining({
      event: 'turn_complete',
      turn_id: turn,
      reply: 'final answer',
    }),
    'selected',
  );
  await f.event('execution.succeeded');
  expect(f.get).toHaveBeenCalledOnce();
});

it.each(['success', 'failure'])(
  'discards a late %s after the selected conversation changes',
  async (outcome) => {
    const f = await fixture();
    await f.prompt();
    await f.event('inbox.delivered', { inboxID: 'input' });
    await f.event('step.started', { assistantMessageID: 'answer' });
    let finish!: (value?: unknown) => void;
    f.get.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finish = () =>
            outcome === 'success' ? resolve({} as never) : reject(new Error('late failure'));
        }),
    );
    const pending = f.event('execution.succeeded');
    f.leave();
    finish();
    await pending;
    expect(f.signal).toHaveBeenCalledOnce();
  },
);

it('ignores side threads and rejects a completion without its observed assistant step', async () => {
  const f = await fixture();
  await f.event('inbox.enqueued', {
    sessionID: 'side',
    inboxID: 'side',
    item: { type: 'user', payload: { text: 'side' } },
  });
  expect(f.signal).not.toHaveBeenCalled();
  await f.prompt();
  await f.event('inbox.delivered', { inboxID: 'input' });
  await f.event('execution.succeeded');
  expect(f.signal).toHaveBeenLastCalledWith(
    expect.objectContaining({ event: 'turn_failed' }),
    'selected',
  );
  expect(f.get).not.toHaveBeenCalled();
});

it('replaces earlier admitted input and handles exact cancellation', async () => {
  const f = await fixture();
  const old = await f.prompt();
  const next = await f.prompt('next');
  expect(f.signal).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ event: 'turn_failed', turn_id: old.turn }),
    'selected',
  );
  await f.event('inbox.cancelled', { inboxID: 'input' });
  expect(f.signal).toHaveBeenCalledTimes(3);
  await f.event('inbox.cancelled', { inboxID: 'next' });
  expect(f.signal).toHaveBeenLastCalledWith(
    expect.objectContaining({ event: 'turn_failed', turn_id: next.turn }),
    'selected',
  );
});
