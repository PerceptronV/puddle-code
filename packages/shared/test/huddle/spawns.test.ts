import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  HUDDLE_RUNTIME_CAPABILITIES,
  huddleOwnerRequestSchema,
  huddleOwnerResponseSchema,
  huddleSpawnOperationSchema,
  huddleSpawnPageSchema,
  supportsHuddleRuntime,
} from '../../src/index.js';
import { canAdoptHuddle, daemonRuntimeCapabilities } from '../../src/installation/runtime-roles.js';

const scope = {
  owner: {
    runtime_id: randomUUID(),
    incarnation: randomUUID(),
    launch_id: randomUUID(),
    profile_id: '0123456789',
    project_id: 'abcdef1234',
    session_id: randomUUID(),
    canonical_worktree_path: '/work/project',
  },
  executionId: randomUUID(),
  invocationId: randomUUID(),
  operationId: randomUUID(),
  activationId: randomUUID(),
  revision: 'a'.repeat(64),
};
const operation = {
  scope,
  node: 'worker',
  request: {
    projectId: scope.owner.project_id,
    worktree: '/work/project',
    accountId: 1,
    agent: 'fixture',
    mode: 'headless',
    title: 'Agent',
  },
  deadline: Date.now() + 60000,
  active: true,
  state: 'prepared',
};
const result = {
  agent: {
    runtimeId: randomUUID(),
    incarnation: randomUUID(),
    sessionId: randomUUID(),
    projectId: scope.owner.project_id,
    worktree: '/work/project',
  },
  receipt: 'b'.repeat(64),
};

it('recognises the gated spawn contract without advertising it in default builds', () => {
  const required = { ...HUDDLE_RUNTIME_CAPABILITIES, spawns: 1 };
  expect(HUDDLE_RUNTIME_CAPABILITIES.spawns).toBeUndefined();
  expect(supportsHuddleRuntime(HUDDLE_RUNTIME_CAPABILITIES)).toBe(true);
  expect(supportsHuddleRuntime(required)).toBe(true);
  expect(supportsHuddleRuntime({ ...required, spawns: 2 })).toBe(false);
  for (const operations of [undefined, 1, 3])
    expect(supportsHuddleRuntime({ ...required, operations })).toBe(false);
  const candidate = daemonRuntimeCapabilities('fixture');
  expect(canAdoptHuddle(candidate, required)).toBe(false);
  candidate.roles.huddle = required;
  expect(canAdoptHuddle(candidate, required)).toBe(true);
  expect(canAdoptHuddle(candidate, HUDDLE_RUNTIME_CAPABILITIES)).toBe(true);
});

it('validates separate spawn commands without widening the existing ask contract', () => {
  const base = { id: randomUUID(), sequence: 1 };
  expect(
    huddleOwnerRequestSchema.safeParse({
      ...base,
      t: 'spawn-claim',
      operationId: scope.operationId,
    }).success,
  ).toBe(true);
  expect(
    huddleOwnerRequestSchema.safeParse({ ...base, t: 'spawn-settle', scope, result }).success,
  ).toBe(true);
  expect(
    huddleOwnerRequestSchema.safeParse({ ...base, t: 'operation-settle', scope, result }).success,
  ).toBe(false);
  expect(
    huddleOwnerRequestSchema.safeParse({
      ...base,
      t: 'spawn-settle',
      scope: { ...scope, target: result.agent },
      result,
    }).success,
  ).toBe(false);
  expect(
    huddleOwnerRequestSchema.safeParse({
      ...base,
      t: 'spawn-unavailable',
      scope,
      unsent: true,
      error: 'x'.repeat(4097),
    }).success,
  ).toBe(false);
  expect(
    huddleOwnerResponseSchema.safeParse({
      id: base.id,
      t: 'spawn-settled',
      operationId: scope.operationId,
      result,
    }).success,
  ).toBe(true);
  expect(
    huddleOwnerResponseSchema.safeParse({
      id: base.id,
      t: 'spawn-claim',
      dispatch: true,
      operation,
    }).success,
  ).toBe(true);
});

it('bounds spawn pages and rejects inconsistent state, result and scope', () => {
  expect(huddleSpawnOperationSchema.safeParse(operation).success).toBe(true);
  expect(
    huddleSpawnOperationSchema.safeParse({ ...operation, state: 'completed', result }).success,
  ).toBe(true);
  for (const invalid of [
    { ...operation, state: 'completed' },
    { ...operation, result },
    { ...operation, state: 'failed', result },
    {
      ...operation,
      state: 'completed',
      result: { ...result, agent: { ...result.agent, worktree: '/other' } },
    },
    { ...operation, request: { ...operation.request, projectId: 'aaaaaaaaaa' } },
  ])
    expect(huddleSpawnOperationSchema.safeParse(invalid).success).toBe(false);
  const row = { ordinal: 1, operation };
  expect(huddleSpawnPageSchema.safeParse({ records: [row], next: 1 }).success).toBe(true);
  for (const page of [
    { records: [row], next: 0 },
    { records: [row, row], next: 1 },
    {
      records: Array.from({ length: 17 }, (_, i) => ({
        ordinal: i + 1,
        operation: { ...operation, scope: { ...scope, operationId: randomUUID() } },
      })),
      next: 17,
    },
  ])
    expect(huddleSpawnPageSchema.safeParse(page).success).toBe(false);
});
