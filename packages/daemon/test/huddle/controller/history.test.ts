import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { huddleDefinitionSchema } from '@puddle/shared';
import {
  huddleHistoryQuerySchema,
  readHuddleHistoryPage,
} from '../../../src/runtime/huddle/controller/history.js';

const execution = {
  id: randomUUID(),
  eventKey: 'a'.repeat(64),
  revision: 'b'.repeat(64),
  state: 'running',
  limits: huddleDefinitionSchema.parse({
    format: 1,
    id: 'c'.repeat(32),
    name: 'Test',
    nodes: [],
    edges: [],
  }).execution,
  acceptedAt: 1,
  deadline: 100,
  turns: 0,
  spawns: 0,
  invocations: 0,
};
const row = (record = execution, ordinal = 1) => ({
  id: record.id,
  ordinal,
  body: JSON.stringify(record),
});
const query = { collection: 'executions' as const, after: 0 };

it('rejects malformed or unscoped history queries before requesting private records', () => {
  for (const invalid of [
    { ...query, collection: 'control' },
    { ...query, after: -1 },
    { ...query, after: Number.MAX_SAFE_INTEGER + 1 },
    { ...query, parent: randomUUID() },
    { ...query, limit: 100_000 },
    { collection: 'invocations', after: 0 },
    { collection: 'operations', after: 0, parent: 'anything' },
  ])
    expect(huddleHistoryQuerySchema.safeParse(invalid).success).toBe(false);
});

it('rejects malformed records, identity mismatch and wrong revision filters', () => {
  for (const rows of [
    [{ ...row(), body: 'not json' }],
    [{ ...row(), body: JSON.stringify({ ...execution, state: 'unknown' }) }],
    [{ ...row(), id: randomUUID() }],
    [{ ...row(), body: JSON.stringify({ ...execution, secret: 'unrecognised field' }) }],
  ])
    expect(() => readHuddleHistoryPage(query, rows)).toThrow();
  expect(() => readHuddleHistoryPage({ ...query, parent: 'd'.repeat(64) }, [row()])).toThrow(
    'revision',
  );
});

it('rejects duplicated, backwards and oversized pages; empty pages preserve their cursor', () => {
  for (const rows of [
    [row(execution, 0)],
    [row(execution, 2), row({ ...execution, id: randomUUID() }, 1)],
    [row(), row(execution, 2)],
    [row(execution, 0.5)],
    Array.from({ length: 257 }, (_, n) => row({ ...execution, id: randomUUID() }, n + 1)),
    [{ ...row(), body: 'x'.repeat(1024 * 1024 + 1) }],
  ])
    expect(() => readHuddleHistoryPage(query, rows)).toThrow();
  expect(readHuddleHistoryPage({ ...query, after: 99 }, [])).toEqual({
    collection: 'executions',
    records: [],
    next: 99,
  });
  expect(readHuddleHistoryPage(query, [row()])).toMatchObject({
    next: 1,
    records: [{ ordinal: 1, record: execution }],
  });
});

it('checks invocation and operation execution identities and keeps unknown operations distinct', () => {
  const invocation = {
    id: randomUUID(),
    executionId: execution.id,
    revision: execution.revision,
    node: 'review',
    activation: 'root',
    iteration: 0,
    inputs: {},
    state: 'running',
  };
  const operation = {
    id: randomUUID(),
    invocationId: invocation.id,
    executionId: execution.id,
    kind: 'ask',
    target: {},
    input: {},
    state: 'unknown',
    consumed: true,
    error: 'Reply lost',
  };
  for (const [collection, record] of [
    ['invocations', invocation],
    ['operations', operation],
  ] as const) {
    const rows = [{ id: record.id, ordinal: 5, body: JSON.stringify(record) }];
    expect(() =>
      readHuddleHistoryPage({ collection, after: 0, parent: randomUUID() }, rows),
    ).toThrow('execution');
    expect(
      readHuddleHistoryPage({ collection, after: 0, parent: execution.id }, rows).records[0]!
        .record,
    ).toMatchObject(record);
  }
});
