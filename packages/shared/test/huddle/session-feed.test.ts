import { expect, it } from 'vitest';
import { huddleSessionFeedPageSchema, huddleSessionFeedRecordSchema } from '../../src/index.js';

const record = {
  sequence: 1,
  profileId: 'a'.repeat(10),
  projectId: 'b'.repeat(10),
  sessionId: '11111111-1111-4111-8111-111111111111',
  worktree: '/project',
  sessionKind: 'agent',
  event: 'status',
  source: 'status',
  previousStatus: 'running',
  status: 'waiting_input',
  observedAt: '2026-11-08T00:00:00.000Z',
};
const cursor = { epoch: 'c'.repeat(32), sequence: 1 };
it('keeps observed status transitions distinct from exact turn completion and audit records', () => {
  expect(huddleSessionFeedRecordSchema.safeParse(record).success).toBe(true);
  for (const extra of [
    { event: 'turn_completed' },
    { source: 'audit' },
    { previousStatus: null },
    { previousStatus: 'waiting_input' },
    { reply: 'not a retained native result' },
  ])
    expect(huddleSessionFeedRecordSchema.safeParse({ ...record, ...extra }).success).toBe(false);
});
it('rejects out-of-order pages, impossible checkpoints and oversized encoded metadata', () => {
  const page = { state: 'events', cursor, head: 2, records: [record] };
  expect(huddleSessionFeedPageSchema.safeParse(page).success).toBe(true);
  for (const extra of [
    { head: 0 },
    { cursor: { ...cursor, sequence: 0 } },
    { records: [record, record] },
  ])
    expect(huddleSessionFeedPageSchema.safeParse({ ...page, ...extra }).success).toBe(false);
  expect(
    huddleSessionFeedPageSchema.safeParse({ state: 'gap', cursor, floor: 2, reason: 'retention' })
      .success,
  ).toBe(false);
  expect(
    huddleSessionFeedRecordSchema.safeParse({ ...record, worktree: '/' + '\u0001'.repeat(2000) })
      .success,
  ).toBe(false);
});
