import { describe, expect, it } from 'vitest';
import { CodexControl } from '../../../../src/agents/codex/control.js';
import { RuntimeBufferBudget } from '../../../../src/runtime/resources/budget.js';

describe('Codex retained control work', () => {
  it('refuses before dispatch when the owner cannot retain a turn', async () => {
    const owner = new RuntimeBufferBudget({ bytes: 1024, count: 100 });
    const control = new CodexControl(owner);
    const sent: unknown[] = [];
    control.connect((message) => sent.push(message));
    control.bind('thread');
    await expect(control.ask('task', new AbortController().signal)).rejects.toThrow('capacity');
    expect(sent).toEqual([]);
    expect(owner.usedBytes).toBe(0);
  });
  it('bounds unanswered cancelled requests across native switches and still interrupts exact late responses', async () => {
    const owner = new RuntimeBufferBudget({ bytes: 32 * 1024 * 1024, count: 1000 });
    const control = new CodexControl(owner);
    const sent: Array<Record<string, unknown>> = [];
    control.connect((message) => sent.push(message));
    for (let i = 0; i < 256; i++) {
      control.bind(`thread-${i}`);
      const abort = new AbortController();
      const result = control.ask('task', abort.signal);
      abort.abort();
      await expect(result).rejects.toThrow('cancelled');
    }
    expect(owner.usedCount).toBe(256);
    control.bind('next');
    await expect(control.ask('blocked', new AbortController().signal)).rejects.toThrow(
      'unanswered',
    );
    expect(sent).toHaveLength(256);
    control.server({ id: sent[0]!.id, result: { turn: { id: 'late' } } });
    expect(sent.at(-1)).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'thread-0', turnId: 'late' },
    });
    expect(owner.usedCount).toBe(255);
    control.disconnect();
    expect(owner.usedBytes).toBe(0);
  });
});

it('retains early parsed-tree metadata through drain and releases it on completion', async () => {
  const owner = new RuntimeBufferBudget({ bytes: 32 * 1024 * 1024, count: 1000 });
  const control = new CodexControl(owner);
  const sent: Array<Record<string, unknown>> = [];
  control.connect((message) => sent.push(message));
  control.bind('thread');
  const result = control.ask('task', new AbortController().signal);
  const before = owner.usedBytes;
  control.server({
    method: 'item/completed',
    params: {
      threadId: 'thread',
      turnId: 'owned',
      item: {
        type: 'agentMessage',
        text: 'answer',
        metadata: Array.from({ length: 10000 }, () => ({})),
      },
    },
  });
  expect(owner.usedBytes - before).toBeGreaterThan(1024 * 1024);
  control.server({ id: sent[0]!.id, result: { turn: { id: 'owned', status: 'inProgress' } } });
  expect(owner.usedBytes).toBe(before);
  control.server({
    method: 'turn/completed',
    params: { threadId: 'thread', turn: { id: 'owned', status: 'completed', items: [] } },
  });
  await expect(result).resolves.toBe('answer');
  expect(owner.usedBytes).toBe(0);
});

it('fails only the scripted turn when early metadata cannot be retained', async () => {
  const owner = new RuntimeBufferBudget({ bytes: 9 * 1024 * 1024, count: 1000 });
  const control = new CodexControl(owner);
  const sent: Array<Record<string, unknown>> = [];
  control.connect((message) => sent.push(message));
  control.bind('thread');
  const result = control.ask('task', new AbortController().signal);
  expect(
    control.server({
      method: 'item/completed',
      params: {
        threadId: 'thread',
        turnId: 'owned',
        item: {
          type: 'agentMessage',
          text: 'answer',
          metadata: Array.from({ length: 10000 }, () => ({})),
        },
      },
    }),
  ).toBe(false);
  await expect(result).rejects.toThrow('metadata capacity');
  expect(owner.usedBytes).toBe(0);
  expect(sent).toHaveLength(1);
  control.server({
    method: 'turn/completed',
    params: { threadId: 'thread', turn: { id: 'owned', status: 'completed', items: [] } },
  });
  expect(control.ready).toBe(true);
});

it('bounds native diagnostics before they escape into rejected promises', async () => {
  const owner = new RuntimeBufferBudget({ bytes: 16 * 1024 * 1024, count: 100 });
  const control = new CodexControl(owner);
  const sent: Array<Record<string, unknown>> = [];
  control.connect((message) => sent.push(message));
  control.bind('thread');
  const result = control.ask('task', new AbortController().signal);
  control.server({ id: sent[0]!.id, error: { message: 'x'.repeat(100000) } });
  await expect(result).rejects.toMatchObject({ message: 'x'.repeat(4096) });
  expect(owner.usedBytes).toBe(0);
  const oversized = control.ask('next', new AbortController().signal);
  control.server({
    id: sent[1]!.id,
    result: { turn: { id: 'x'.repeat(4097), status: 'inProgress' } },
  });
  await expect(oversized).rejects.toThrow('rejected');
  expect(owner.usedBytes).toBe(0);
  expect(sent).toHaveLength(2);
  const abort = new AbortController();
  const cancelled = control.ask('last', abort.signal);
  abort.abort();
  await expect(cancelled).rejects.toThrow('cancelled');
  control.server({
    id: sent[2]!.id,
    result: { turn: { id: 'x'.repeat(4097), status: 'inProgress' } },
  });
  expect(sent).toHaveLength(3);
  expect(owner.usedBytes).toBe(0);
});
