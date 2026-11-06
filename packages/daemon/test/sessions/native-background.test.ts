import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session } from '@puddle/shared';
import { EventStore } from '../../src/db/stores/events.js';
import { attachNativeBackground } from '../../src/sessions/native-background.js';
import type { SessionServiceDeps } from '../../src/sessions/service.js';
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(
    'CREATE TABLE events (id INTEGER PRIMARY KEY, session_id TEXT, type TEXT, payload TEXT, created_at TEXT)',
  );
  const source = {
    id: 'source',
    project_id: 'project',
    account_id: 1,
    agent_mode: 'interactive',
    worktree_path: '/synthetic',
    status: 'running',
    conversation_id: 1,
    agent_session_ref: 'original',
  } as Session;
  const target = {
    ...source,
    id: 'copy',
    status: 'exited',
    conversation_id: 2,
    agent_session_ref: 'copy',
  } as Session;
  const parent = { id: 1, agent_session_ref: 'original' };
  const conversation = {
    id: 2,
    agent_type: 'claude-code',
    profile_id: 'profile',
    parent_conversation_id: 1,
    native_created_at: '2026-11-06T00:01:00.000Z',
    missing: false,
  };
  const owner = { runtime_id: 'owner', created_at: '2026-11-06T00:00:00.000Z' };
  const deps = {
    accounts: { get: () => ({ agent_type: 'claude-code', profile_id: 'profile' }) },
    conversations: {
      get: (id: number) => (id === 1 ? parent : conversation),
      placements: (id: number) => (id === 1 ? ['source'] : ['copy']),
    },
    sessions: { get: (id: string) => ({ ...(id === 'source' ? source : target) }) },
    runtimes: { ownerOf: (id: string) => (id === 'source' ? owner : null) },
    events: new EventStore(db),
  } as unknown as Pick<
    SessionServiceDeps,
    'accounts' | 'conversations' | 'sessions' | 'runtimes' | 'events'
  >;
  return { deps, source, target, conversation, owner };
}
it('attaches the managed copy once without replacing its source', async () => {
  const f = fixture();
  const resume = vi.fn(async (id, guard) => {
    expect(id).toBe('copy');
    guard();
    return f.target;
  });
  const event = await attachNativeBackground(f.deps, 1, 2, resume, () => true);
  expect(event).toMatchObject({
    sourceSession: 'source',
    targetSession: 'copy',
    cause: 'fork',
    outcome: 'focused-existing',
  });
  await attachNativeBackground(f.deps, 1, 2, resume, () => true);
  expect(resume).toHaveBeenCalledOnce();
  expect(f.source.status).toBe('running');
});
it('does not redispatch a lost launch reply', async () => {
  const f = fixture();
  const resume = vi.fn(async () => {
    throw new Error('lost');
  });
  await expect(attachNativeBackground(f.deps, 1, 2, resume, () => true)).rejects.toThrow('lost');
  await attachNativeBackground(f.deps, 1, 2, resume, () => true);
  expect(resume).toHaveBeenCalledOnce();
});
it.each(['historical', 'account', 'archived', 'placement', 'headless', 'shutdown'])(
  'ignores a %s copy',
  async (reason) => {
    const f = fixture(),
      resume = vi.fn();
    if (reason === 'historical') f.owner.created_at = '2026-11-06T00:02:00.000Z';
    if (reason === 'account') f.target.account_id = 2;
    if (reason === 'archived') f.target.status = 'archived';
    if (reason === 'placement') f.target.worktree_path = '/elsewhere';
    if (reason === 'headless') f.source.agent_mode = 'headless';
    expect(
      await attachNativeBackground(f.deps, 1, 2, resume, () => reason !== 'shutdown'),
    ).toBeNull();
    expect(resume).not.toHaveBeenCalled();
  },
);
it('rechecks the original owner before dispatch after asynchronous admission', async () => {
  const f = fixture();
  await expect(
    attachNativeBackground(
      f.deps,
      1,
      2,
      async (_id, guard) => {
        f.source.conversation_id = 3;
        guard();
        return f.target;
      },
      () => true,
    ),
  ).rejects.toThrow('changed before');
});
