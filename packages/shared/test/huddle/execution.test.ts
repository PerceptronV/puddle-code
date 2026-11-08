import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  huddleRunSchema,
  huddleHistoryRequestSchema,
  huddleOperationViewSchema,
  huddleRuntimeInspectionSchema,
} from '../../src/api/huddle/execution.js';

const target = {
  runtimeId: randomUUID(),
  incarnation: randomUUID(),
  generation: 1,
  activationId: randomUUID(),
};

it('requires a complete reviewed target and bounded explicit Run input', () => {
  const request = { target, node: 'run', event_id: randomUUID(), data: null };
  expect(huddleRunSchema.safeParse(request).success).toBe(true);
  for (const invalid of [
    { ...request, data: undefined },
    { ...request, event_id: 'retry' },
    { ...request, target: { ...target, generation: Number.MAX_SAFE_INTEGER + 1 } },
    { ...request, data: 'x'.repeat(256 * 1024 + 1) },
    { ...request, runtime_secret: 'never accepted' },
  ])
    expect(huddleRunSchema.safeParse(invalid).success).toBe(false);
});

it('keeps private operation inputs and targets out of public history', () => {
  const record = {
    id: randomUUID(),
    invocationId: randomUUID(),
    executionId: randomUUID(),
    kind: 'ask',
    state: 'unknown',
    consumed: true,
    error: 'Outcome unavailable',
  };
  expect(
    huddleOperationViewSchema.parse({
      ...record,
      target: { private: true },
      input: { private: true },
      future_private_field: 'secret',
    }),
  ).toEqual(record);
  expect(
    huddleHistoryRequestSchema.safeParse({
      owner: target,
      collection: 'operations',
      after: 0,
      parent: record.executionId,
    }).success,
  ).toBe(false);
  expect(
    huddleHistoryRequestSchema.safeParse({
      owner: { runtimeId: target.runtimeId, incarnation: target.incarnation },
      collection: 'operations',
      after: 0,
    }).success,
  ).toBe(false);
});

it('represents an unobserved owner without inventing its lifecycle or command target', () => {
  const inspection = {
    session_id: randomUUID(),
    unresolved: true,
    owner: {
      connected: false,
      identity: { runtimeId: target.runtimeId, incarnation: target.incarnation },
      build: '1.2.3',
    },
  };
  expect(huddleRuntimeInspectionSchema.safeParse(inspection).success).toBe(true);
  expect(
    huddleRuntimeInspectionSchema.safeParse({
      ...inspection,
      owner: { ...inspection.owner, lifecycle: 'armed', target },
    }).success,
  ).toBe(false);
});
