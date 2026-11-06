import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session } from '@puddle/shared';
import { EventStore } from '../../src/db/stores/events.js';
import { preserveNativeSource } from '../../src/sessions/native-creation.js';
import type { SessionServiceDeps, SessionSwitchEvent } from '../../src/sessions/service.js';
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
    status: 'exited',
    conversation_id: 1,
    agent_session_ref: 'original',
  } as Session;
  const target = {
    id: 'target',
    status: 'running',
    conversation_id: 2,
    parent_conversation_id: 1,
  } as Session;
  const deps = {
    sessions: { get: (id: string) => ({ ...(id === 'source' ? source : target) }) },
    events: new EventStore(db),
  } as Pick<SessionServiceDeps, 'sessions' | 'events' | 'runtimes' | 'runtimeSwitchSettled'>;
  const event: SessionSwitchEvent = {
    sourceSession: 'source',
    targetSession: 'target',
    targetProject: 'project',
    cause: 'fork',
    outcome: 'rebound',
  };
  return { deps, event, source, target };
}
it.each(['clear', 'fork'] as const)(
  'resumes the exact saved source once after native %s',
  async (cause) => {
    const f = fixture();
    f.event.cause = cause;
    const resume = vi.fn(async (id, guard) => {
      expect(id).toBe('source');
      guard();
    });
    await preserveNativeSource(f.deps, f.event, resume, () => true);
    await preserveNativeSource(f.deps, f.event, resume, () => true);
    expect(resume).toHaveBeenCalledOnce();
    expect(f.deps.events.list('source')).toHaveLength(1);
  },
);
it('does not redispatch after an uncertain launch reply', async () => {
  const f = fixture();
  const resume = vi.fn(async () => {
    throw new Error('reply lost');
  });
  await expect(preserveNativeSource(f.deps, f.event, resume, () => true)).rejects.toThrow(
    'reply lost',
  );
  await preserveNativeSource(f.deps, f.event, resume, () => true);
  expect(resume).toHaveBeenCalledOnce();
});
it('waits for placement acknowledgement and rechecks source identity after that wait', async () => {
  const f = fixture();
  f.deps.runtimes = {
    ownerOf: (id: string) => (id === 'target' ? { runtime_id: 'owner' } : null),
  } as never;
  let release!: (value: boolean) => void;
  f.deps.runtimeSwitchSettled = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const resume = vi.fn();
  const pending = preserveNativeSource(f.deps, f.event, resume, () => true);
  expect(resume).not.toHaveBeenCalled();
  f.source.status = 'archived';
  release(true);
  await expect(pending).rejects.toThrow('original conversation changed');
  expect(resume).not.toHaveBeenCalled();
  expect(f.deps.events.list('source')).toHaveLength(0);
});
it('does not relaunch on resume, conflict, shutdown or a foreign fork parent', async () => {
  const f = fixture();
  const resume = vi.fn();
  await preserveNativeSource(f.deps, { ...f.event, cause: 'resume' }, resume, () => true);
  await preserveNativeSource(
    f.deps,
    { ...f.event, outcome: 'focused-existing' },
    resume,
    () => true,
  );
  await preserveNativeSource(f.deps, f.event, resume, () => false);
  f.target.parent_conversation_id = 3;
  await preserveNativeSource(f.deps, f.event, resume, () => true);
  expect(resume).not.toHaveBeenCalled();
});
