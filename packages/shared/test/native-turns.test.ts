import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  agentNativeTurnSchema,
  runtimeNativeTurnRecordSchema,
  runtimeNativeTurnPageSchema,
  runtimeRequestSchema,
} from '../src/index.js';
it('validates exact outcomes, bounded replies and automated attribution', () => {
  const base = {
    event: 'completed',
    agentSessionRef: 'ref',
    nativeTurnId: 'native-turn',
    automated: true,
    automation: { turn: 2 },
    reply: 'reply',
  };
  expect(agentNativeTurnSchema.safeParse(base).success).toBe(true);
  for (const patch of [
    { reply: undefined },
    { error: 'failed' },
    { reply: 'é'.repeat(256 * 1024) },
    { automated: false },
    { event: 'started' },
  ])
    expect(agentNativeTurnSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  const { automated: _, automation, ...event } = base;
  expect(
    runtimeNativeTurnRecordSchema.safeParse({
      ...event,
      sequence: 1,
      observedAt: new Date().toISOString(),
      segmentId: randomUUID(),
      sessionId: null,
      origin: { kind: 'automation', ...automation },
    }).success,
  ).toBe(true);
});
it('keeps native reads separate from ordinary acknowledgements and rejects impossible cursors', () => {
  const cursor = { epoch: 'a'.repeat(32), sequence: 2 };
  expect(
    runtimeRequestSchema.safeParse({
      t: 'native-turns',
      id: randomUUID(),
      sequence: 1,
      after: cursor,
    }).success,
  ).toBe(true);
  expect(
    runtimeNativeTurnPageSchema.safeParse({
      state: 'events',
      cursor,
      head: 1,
      records: [],
      persistencePending: false,
    }).success,
  ).toBe(false);
  expect(
    runtimeNativeTurnPageSchema.safeParse({
      state: 'gap',
      cursor,
      floor: 3,
      reason: 'retention',
      persistencePending: false,
    }).success,
  ).toBe(false);
});
