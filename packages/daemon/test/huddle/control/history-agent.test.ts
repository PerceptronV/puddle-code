import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { huddleHistoryPageSchema, type HuddleOperationRecord } from '@puddle/shared';
import { projectHuddleHistory } from '../../../src/huddle/execution/history/projection.js';

it('projects only exact agent operation identities when requested, without leaking private targets', () => {
  const target = {
    sessionId: randomUUID(),
    runtimeId: randomUUID(),
    incarnation: randomUUID(),
    projectId: 'a'.repeat(10),
    worktree: '/worktree',
  };
  const agent = {
    sessionId: target.sessionId,
    runtimeId: target.runtimeId,
    projectId: target.projectId,
    worktree: target.worktree,
  };
  const record: HuddleOperationRecord = {
    id: randomUUID(),
    invocationId: randomUUID(),
    executionId: randomUUID(),
    kind: 'ask',
    state: 'dispatched',
    consumed: true,
    target,
    input: { prompt: 'private prompt' },
  };
  const page = (value: HuddleOperationRecord, include = true) =>
    huddleHistoryPageSchema.parse(
      projectHuddleHistory(
        {
          owner: { runtimeId: randomUUID(), incarnation: randomUUID() },
          collection: 'operations',
          next: 1,
          records: [{ ordinal: 1, record: value }],
        },
        false,
        include,
      ),
    ).records[0]!.record;
  expect(page(record, false)).not.toHaveProperty('agent');
  expect(page(record)).toMatchObject({ agent });
  expect(page(record)).not.toHaveProperty('target');
  expect(page(record)).not.toHaveProperty('input');
  expect(page(record)).not.toHaveProperty('agent.incarnation');
  const outcome = { agent: target, receipt: 'a'.repeat(64) };
  for (const kind of ['spawn', 'resume', 'restart'] as const)
    expect(page({ ...record, kind, state: 'completed', result: outcome })).toMatchObject({ agent });
  const lifecycle = {
    ...target,
    accountId: 1,
    agent: 'codex',
    mode: 'interactive',
    nativeRef: 'private conversation',
    runtime: target,
  };
  delete (lifecycle as Partial<typeof lifecycle>).incarnation;
  delete (lifecycle as Partial<typeof lifecycle>).runtimeId;
  expect(page({ ...record, kind: 'restart', target: lifecycle })).toMatchObject({ agent });
  const resume = page({ ...record, kind: 'resume', target: { ...lifecycle, runtime: null } });
  expect(resume).toMatchObject({
    agent: { sessionId: target.sessionId, projectId: target.projectId, worktree: '/worktree' },
  });
  expect(resume).not.toHaveProperty('agent.runtimeId');
  for (const value of [
    { ...record, kind: 'readout' as const, state: 'completed' as const, result: outcome },
    {
      ...record,
      kind: 'spawn' as const,
      state: 'completed' as const,
      result: { runtime_id: target.runtimeId, session_id: target.sessionId },
    },
    { ...record, kind: 'spawn' as const, state: 'unknown' as const },
    { ...record, target: { sessionId: target.sessionId } },
  ])
    expect(page(value)).not.toHaveProperty('agent');
});
