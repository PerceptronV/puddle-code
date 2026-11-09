import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  huddleHistoryOwnersRequestSchema,
  huddleRetainedHistoryRequestSchema,
  parseHuddleRetainedHistory,
} from '../../src/index.js';
const owner = { runtimeId: randomUUID(), incarnation: randomUUID() };
const input = { owner, collection: 'executions' as const, after: 0 };
const response = {
  source: 'retained-ledger',
  observed_at: new Date().toISOString(),
  history: { owner, collection: 'executions', records: [], next: 0 },
};
it('requires exact recorded identity and page correspondence', () => {
  expect(parseHuddleRetainedHistory(input, response)).toEqual(response);
  for (const history of [
    { ...response.history, owner: { ...owner, incarnation: randomUUID() } },
    { ...response.history, collection: 'operations' },
    { ...response.history, next: 1 },
  ])
    expect(() => parseHuddleRetainedHistory(input, { ...response, history })).toThrow();
});
it('offers retained observation without reconciliation and rejects malformed catalogue cursors', () => {
  expect(
    huddleRetainedHistoryRequestSchema.safeParse({ ...input, include_readout_observation: true })
      .success,
  ).toBe(true);
  expect(huddleRetainedHistoryRequestSchema.safeParse({ ...input, reconcile: true }).success).toBe(
    false,
  );
  expect(
    huddleHistoryOwnersRequestSchema.safeParse({
      after: { runtime_id: owner.runtimeId, created_at: 'invalid' },
    }).success,
  ).toBe(false);
});
it('checks ordering and parent identity rather than accepting an unrelated valid record', () => {
  const executionId = randomUUID();
  const query = { owner, collection: 'invocations' as const, after: 0, parent: executionId };
  const row = {
    ordinal: 1,
    record: {
      id: randomUUID(),
      executionId,
      revision: 'a'.repeat(64),
      node: 'node',
      iteration: 0,
      state: 'completed',
      inputs: null,
      result: 'answer',
    },
  };
  const value = {
    ...response,
    history: { owner, collection: 'invocations', records: [row], next: 1 },
  };
  expect(parseHuddleRetainedHistory(query, value).history.records).toHaveLength(1);
  expect(() => parseHuddleRetainedHistory({ ...query, parent: randomUUID() }, value)).toThrow(
    'execution',
  );
  expect(() => parseHuddleRetainedHistory({ ...query, after: 1 }, value)).toThrow('ordering');
});
