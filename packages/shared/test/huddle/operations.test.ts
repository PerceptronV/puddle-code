import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  HUDDLE_RUNTIME_CAPABILITIES,
  supportsHuddleRuntime,
  encodeHuddleAgentTarget,
  decodeHuddleAgentTarget,
  huddleAgentOperationSchema,
  huddleAgentOutcomeSchema,
  huddleOperationPageSchema,
} from '../../src/index.js';
import { canAdoptHuddle, daemonRuntimeCapabilities } from '../../src/installation/runtime-roles.js';

const target = {
  runtimeId: randomUUID(),
  incarnation: randomUUID(),
  sessionId: randomUUID(),
  projectId: 'abcdef1234',
  worktree: '/work/project',
};
const operation = {
  scope: {
    owner: {
      runtime_id: randomUUID(),
      incarnation: randomUUID(),
      launch_id: randomUUID(),
      profile_id: '0123456789',
      project_id: target.projectId,
      session_id: randomUUID(),
      canonical_worktree_path: target.worktree,
    },
    executionId: randomUUID(),
    invocationId: randomUUID(),
    operationId: randomUUID(),
    activationId: randomUUID(),
    revision: 'a'.repeat(64),
    target,
  },
  node: 'coder',
  request: { prompt: 'review' },
  deadline: Date.now() + 60000,
  active: true,
  state: 'prepared',
};
const outcome = {
  turn: { turn: 1, status: 'completed', expected_ref: 'native', reply: 'done' },
  receipt: 'b'.repeat(64),
};

it('negotiates operation support independently of legacy huddle ownership', () => {
  const { operations: _, ...legacy } = HUDDLE_RUNTIME_CAPABILITIES;
  const candidate = daemonRuntimeCapabilities('fixture');
  expect(supportsHuddleRuntime(legacy)).toBe(true);
  expect(supportsHuddleRuntime({ ...legacy, operations: 3 })).toBe(false);
  expect(canAdoptHuddle(candidate, legacy)).toBe(true);
  expect(canAdoptHuddle(candidate, { ...legacy, operations: 1 })).toBe(true);
  candidate.roles.huddle = { ...legacy, operations: 1 };
  expect(canAdoptHuddle(candidate, HUDDLE_RUNTIME_CAPABILITIES)).toBe(false);
  candidate.roles.huddle = legacy;
  expect(canAdoptHuddle(candidate, HUDDLE_RUNTIME_CAPABILITIES)).toBe(false);
});

it('round-trips bounded inspectable agent bindings and rejects malformed references', () => {
  expect(decodeHuddleAgentTarget(encodeHuddleAgentTarget(target))).toEqual(target);
  expect(() => decodeHuddleAgentTarget(target.sessionId)).toThrow();
  expect(() => decodeHuddleAgentTarget('huddle-agent:{}')).toThrow();
  expect(() => encodeHuddleAgentTarget({ ...target, worktree: '/' + 'x'.repeat(4095) })).toThrow();
});

it('rejects incomplete, inconsistent and oversized outcomes', () => {
  expect(huddleAgentOperationSchema.safeParse(operation).success).toBe(true);
  expect(
    huddleAgentOperationSchema.safeParse({ ...operation, state: 'completed', result: outcome })
      .success,
  ).toBe(true);
  for (const invalid of [
    { ...operation, state: 'completed' },
    { ...operation, state: 'failed', result: outcome },
    { ...operation, result: outcome },
  ])
    expect(huddleAgentOperationSchema.safeParse(invalid).success).toBe(false);
  expect(
    huddleAgentOutcomeSchema.safeParse({
      ...outcome,
      turn: { turn: 1, status: 'running', expected_ref: 'native' },
    }).success,
  ).toBe(false);
  // A raw agent reply may fit its own limit while the JSON outcome cannot fit the ledger value.
  expect(
    huddleAgentOutcomeSchema.safeParse({
      ...outcome,
      turn: { ...outcome.turn, reply: '\n'.repeat(150000) },
    }).success,
  ).toBe(false);
});

it('bounds operation pages and rejects duplicate, backward or out-of-cursor records', () => {
  const first = { ordinal: 1, operation };
  const second = {
    ordinal: 2,
    operation: { ...operation, scope: { ...operation.scope, operationId: randomUUID() } },
  };
  expect(huddleOperationPageSchema.safeParse({ records: [first, second], next: 3 }).success).toBe(
    true,
  );
  for (const page of [
    { records: [second, first], next: 2 },
    { records: [first, { ...first, ordinal: 2 }], next: 2 },
    { records: [first, second], next: 1 },
    { records: Array(17).fill(first), next: 17 },
  ])
    expect(huddleOperationPageSchema.safeParse(page).success).toBe(false);
});
