import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { completionReaderFixture } from '../../../helpers/huddle/completion-reader.js';
import { HuddleCompletionPending } from '../../../../src/huddle/triggers/completions/reader.js';

const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const f = completionReaderFixture();
  cleanups.push(f.close);
  return f;
}
const allowed = () => {};

it('captures an exact durable baseline using observations only, including a busy agent', async () => {
  const f = fixture();
  const result = await f.reader.capture(f.scope, f.selection, allowed);
  expect(result.baseline).toEqual({
    node: 'run',
    target: {
      identity: f.state.identity,
      sessionId: f.session.id,
      segmentId: f.binding.active_segment_id,
      nativeRef: 'native-ref',
    },
    cursor: f.state.native_turns!.cursor,
  });
  expect(f.request.mock.calls.map(([command]) => command.t)).toEqual([
    'inspect',
    'native-turns',
    'inspect',
  ]);
  expect(f.request.mock.calls[1]![0]).toEqual({ t: 'native-turns', after: null });
  expect(f.state.agent!.control_ready).toBe(false);
  expect(() => result.check()).not.toThrow();
  f.binding.incarnation = randomUUID();
  expect(() => result.check()).toThrow('target changed');
});

it.each([
  [
    'old runtime',
    (f: ReturnType<typeof fixture>) => {
      f.state.protocol.minor = 1;
    },
  ],
  [
    'unsupported provider',
    (f: ReturnType<typeof fixture>) => {
      delete f.state.agent!.native_turn_events;
    },
  ],
  [
    'terminal placement',
    (f: ReturnType<typeof fixture>) => {
      f.session.kind = 'terminal';
    },
  ],
  [
    'archived project',
    (f: ReturnType<typeof fixture>) => {
      f.project.archived = true;
    },
  ],
  [
    'foreign profile',
    (f: ReturnType<typeof fixture>) => {
      f.project.profile_id = '1111111111';
    },
  ],
  [
    'foreign project',
    (f: ReturnType<typeof fixture>) => {
      f.session.project_id = '2222222222';
    },
  ],
  [
    'moved worktree',
    (f: ReturnType<typeof fixture>) => {
      f.binding.canonical_worktree_path = '/different';
    },
  ],
  [
    'unbound native ref',
    (f: ReturnType<typeof fixture>) => {
      f.session.agent_session_ref = 'different';
    },
  ],
  [
    'pending identity persistence',
    (f: ReturnType<typeof fixture>) => {
      f.state.persistence_pending = true;
    },
  ],
  [
    'stopping owner',
    (f: ReturnType<typeof fixture>) => {
      f.deps.runtimes.stopRequested.mockReturnValue(true);
    },
  ],
] as const)('rejects %s before querying native history', async (_name, mutate) => {
  const f = fixture();
  mutate(f);
  await expect(f.reader.capture(f.scope, f.selection, allowed)).rejects.toThrow();
  expect(f.request).not.toHaveBeenCalled();
});

it.each([1, 2, 3])('rechecks caller authority after asynchronous read %i', async (at) => {
  const f = fixture();
  let count = 0,
    valid = true;
  f.onRequest(() => {
    if (++count === at) valid = false;
  });
  await expect(
    f.reader.capture(f.scope, f.selection, () => {
      if (!valid) throw new Error('revoked');
    }),
  ).rejects.toThrow('revoked');
  expect(f.request).toHaveBeenCalledTimes(at);
});

it.each([1, 2, 3])('rejects native placement change during asynchronous read %i', async (at) => {
  const f = fixture();
  let count = 0;
  f.onRequest(() => {
    if (++count === at) f.state.binding!.segment_id = randomUUID();
  });
  await expect(f.reader.capture(f.scope, f.selection, allowed)).rejects.toThrow('target changed');
  expect(f.request).toHaveBeenCalledTimes(at);
});

it('refuses undurable baselines and epoch changes without replacing the selected source', async () => {
  const f = fixture();
  f.setPage({ state: 'baseline', cursor: f.state.native_turns!.cursor, persistencePending: true });
  await expect(f.reader.capture(f.scope, f.selection, allowed)).rejects.toThrow(
    'persistence is pending',
  );
  f.setPage({
    state: 'baseline',
    cursor: { epoch: 'b'.repeat(32), sequence: 10 },
    persistencePending: false,
  });
  await expect(f.reader.capture(f.scope, f.selection, allowed)).rejects.toThrow('source changed');
});

it('reads retained pages from the pinned target and reports retention gaps without rebasing', async () => {
  const f = fixture();
  const captured = await f.reader.capture(f.scope, f.selection, allowed);
  f.request.mockClear();
  f.setPage({
    state: 'gap',
    reason: 'retention',
    cursor: f.state.native_turns!.cursor,
    floor: 8,
    persistencePending: false,
  });
  const after = { ...captured.baseline.cursor, sequence: 5 };
  const result = await f.reader.read(f.scope, captured.baseline.target, after, allowed);
  expect(result.page.state).toBe('gap');
  expect(f.request.mock.calls[1]![0]).toEqual({ t: 'native-turns', after });
  f.deps.connections.get.mockReturnValue({ ...f.client } as typeof f.client);
  expect(() => result.check()).toThrow('target changed');
});

it('checks idle sources with one inspection and still fences a changed target before delivery', async () => {
  const f = fixture();
  const captured = await f.reader.capture(f.scope, f.selection, allowed);
  f.request.mockClear();
  const result = await f.reader.read(
    f.scope,
    captured.baseline.target,
    captured.baseline.cursor,
    allowed,
  );
  expect(result.page).toMatchObject({
    state: 'events',
    records: [],
    cursor: captured.baseline.cursor,
  });
  expect(f.request.mock.calls.map(([command]) => command.t)).toEqual(['inspect']);
  f.state.binding!.segment_id = randomUUID();
  expect(result.check).toThrow('target changed');
});

it('treats refused observations as pending while preserving exact identity checks', async () => {
  const f = fixture();
  const captured = await f.reader.capture(f.scope, f.selection, allowed);
  f.request.mockRejectedValue(new Error('Too many runtime requests'));
  await expect(
    f.reader.read(f.scope, captured.baseline.target, captured.baseline.cursor, allowed),
  ).rejects.toBeInstanceOf(HuddleCompletionPending);
  f.binding.incarnation = randomUUID();
  await expect(
    f.reader.read(f.scope, captured.baseline.target, captured.baseline.cursor, allowed),
  ).rejects.toThrow('target changed');
});
