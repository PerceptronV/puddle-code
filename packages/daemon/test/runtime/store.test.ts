import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_PROTOCOL_VERSION } from '@puddle/shared';
import { openDatabase, type Db } from '../../src/db/db.js';
import { ProfileStore } from '../../src/db/stores/profiles.js';
import { ProjectStore } from '../../src/db/stores/projects.js';
import { RepoStore } from '../../src/db/stores/repos.js';
import { SessionStore } from '../../src/db/stores/sessions.js';
import { RuntimeStore } from '../../src/db/stores/runtimes.js';
import { EventStore } from '../../src/db/stores/events.js';
import { ConversationStore } from '../../src/db/stores/conversations.js';
import { reconcilePass } from '../../src/sessions/reconcile.js';
import type { MarkerFileSync } from '../../src/sessions/onboarding.js';

const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = openDatabase(':memory:');
  databases.push(db);
  const profiles = new ProfileStore(db);
  const projects = new ProjectStore(db);
  const sessions = new SessionStore(db);
  const profile = profiles.create({ name: 'runtime-tests', branch_prefix: '' });
  const repo = new RepoStore(db).create({
    path: '/tmp/runtime-source',
    default_base_branch: 'main',
    onboarding_notes: null,
    fetch_enabled: false,
  });
  const project = projects.create({
    profile_id: profile.id,
    repo_id: repo.id,
    name: 'runtime-tests',
  });
  const createSession = (
    projectId = project.id,
    worktree = `/tmp/runtime-worktree-${randomUUID()}`,
  ) =>
    sessions.create({
      id: randomUUID(),
      project_id: projectId,
      account_id: null,
      worktree_path: worktree,
      base_branch: 'main',
      branch: 'main',
      separate_branch: false,
      kind: 'terminal',
      agent_type: null,
      title: null,
      skip_permissions: false,
    });
  const session = createSession();
  const store = new RuntimeStore(db);
  const input = {
    identity: {
      runtime_id: randomUUID(),
      incarnation: randomUUID(),
      launch_id: randomUUID(),
      profile_id: profile.id,
      project_id: project.id,
      session_id: session.id,
      canonical_worktree_path: session.worktree_path,
    },
    build: 'test-1',
    protocol: RUNTIME_PROTOCOL_VERSION,
    releasePath: '/tmp/releases/test-1',
  };
  return {
    db,
    profiles,
    projects,
    sessions,
    profile,
    repo,
    project,
    session,
    store,
    input,
    createSession,
  };
}

describe('durable runtime bindings', () => {
  it('keeps durable owners out of legacy boot interruption even when their processes are unavailable', () => {
    const { db, store, input, session, sessions, projects, createSession } = fixture();
    const binding = store.prepare(input);
    const legacy = createSession();
    const events = new EventStore(db);
    const onboarding = { watch: vi.fn() } as unknown as MarkerFileSync;
    const result = reconcilePass({ sessions, events, projects, onboarding, runtimes: store });
    expect(result).toEqual({ interrupted: [legacy.id], protected: [session.id] });
    expect(sessions.get(session.id).status).toBe('starting');
    expect(events.list(session.id)).toEqual([]);
    expect(store.ownerOf(session.id)).toEqual(binding);
    expect(store.ownerOf(legacy.id)).toBeNull();
    // A stale application status must not authorise resume either.
    sessions.setStatus(session.id, 'interrupted');
    expect(store.ownerOf(session.id)).toEqual(binding);
    expect(store.interrupt(binding.runtime_id, () => {})).toBe(true);
    expect(store.ownerOf(session.id)).toBeNull();
  });

  it('protects another placement of the exact live native conversation without blocking unrelated conversations', () => {
    const { db, store, input, session, sessions, profile, project, createSession } = fixture();
    const conversation = new ConversationStore(db).upsert(profile.id, 'fixture', null, {
      ref: 'owned',
      cwd: session.worktree_path,
    });
    db.prepare("UPDATE sessions SET kind = 'agent', agent_type = 'fixture' WHERE id = ?").run(
      session.id,
    );
    sessions.setConversation(session.id, conversation.id);
    const binding = store.prepare(input);
    const alias = createSession(project.id, '/tmp/another-placement');
    sessions.setConversation(alias.id, conversation.id);
    expect(store.ownerOf(alias.id)).toEqual(binding);
    expect(store.ownerOf(createSession().id)).toBeNull();
    store.interrupt(binding.runtime_id, () => {});
    expect(store.ownerOf(alias.id)).toBeNull();
  });

  it('commits segment boundaries with effects and never remaps existing history', () => {
    const { db, store, input, session, createSession, project } = fixture();
    const original = store.prepare(input);
    const next = createSession(project.id, session.worktree_path);
    const event = {
      cursor: 5,
      sessionId: next.id,
      conversationId: null,
      state: 'running' as const,
      segment: { id: randomUUID(), start_cursor: 5, agent_session_ref: 'next' },
      previousSegmentId: original.runtime_id,
    };
    expect(() =>
      store.observe(original.runtime_id, event, () => {
        db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('partial', next.id);
        throw new Error('Failed effect');
      }),
    ).toThrow('Failed effect');
    expect(store.get(original.runtime_id)).toEqual(original);
    expect(store.segment(original.runtime_id, original.runtime_id)?.end_cursor).toBeNull();
    expect(store.segment(original.runtime_id, event.segment.id)).toBeNull();
    expect(db.prepare('SELECT title FROM sessions WHERE id = ?').get(next.id)).toEqual({
      title: null,
    });
    expect(() =>
      store.observe(original.runtime_id, { ...event, previousSegmentId: randomUUID() }, () => {}),
    ).toThrow(/predecessor/);
    expect(() =>
      store.observe(
        original.runtime_id,
        {
          ...event,
          segment: { id: original.runtime_id, start_cursor: 0, agent_session_ref: null },
          previousSegmentId: undefined,
        },
        () => {},
      ),
    ).toThrow(/immutable/);
    expect(store.observe(original.runtime_id, event, () => {})).toBe(true);
    expect(store.segment(original.runtime_id, original.runtime_id)).toMatchObject({
      session_id: session.id,
      end_cursor: 4,
    });
    expect(store.segment(original.runtime_id, event.segment.id)).toMatchObject({
      session_id: next.id,
      start_cursor: 5,
      end_cursor: null,
    });
    expect(store.placementBinding(original.runtime_id)).toEqual({
      segment_id: event.segment.id,
      session_id: next.id,
      through: 5,
    });
    const duplicate = vi.fn();
    expect(store.observe(original.runtime_id, event, duplicate)).toBe(false);
    expect(duplicate).not.toHaveBeenCalled();
    expect(() =>
      store.observe(
        original.runtime_id,
        { ...event, cursor: 6, previousSegmentId: undefined, sessionId: session.id },
        () => {},
      ),
    ).toThrow(/immutable/);
    expect(store.interrupt(original.runtime_id, () => {})).toBe(true);
    expect(store.segment(original.runtime_id, event.segment.id)?.end_cursor).toBe(5);
    expect(() => store.placementBinding(original.runtime_id)).toThrow(/live committed/);
    expect(store.removeEnded(original.runtime_id)).toBe(true);
    expect(store.segment(original.runtime_id, event.segment.id)).toBeNull();
  });

  it('does not fabricate segment history for older experimental bindings', () => {
    const { db, store, input, session } = fixture();
    const binding = store.prepare(input);
    db.prepare('DELETE FROM runtime_segments WHERE runtime_id = ?').run(binding.runtime_id);
    db.prepare('UPDATE runtime_bindings SET active_segment_id = NULL WHERE runtime_id = ?').run(
      binding.runtime_id,
    );
    expect(() => store.placementBinding(binding.runtime_id)).toThrow(/live committed/);
    expect(() =>
      store.observe(
        binding.runtime_id,
        {
          cursor: 1,
          sessionId: session.id,
          conversationId: null,
          state: 'running',
          segment: { id: binding.runtime_id, start_cursor: 0, agent_session_ref: null },
        },
        () => {},
      ),
    ).toThrow(/no open segment/);
    expect(store.interrupt(binding.runtime_id, () => {})).toBe(true);
  });

  it('records one launch intent and rejects a changed retry or competing live placement', () => {
    const { store, input } = fixture();
    const first = store.prepare(input);
    expect(store.prepare(input)).toEqual(first);
    expect(() => store.prepare({ ...input, build: 'different' })).toThrow(/different inputs/);
    expect(() =>
      store.prepare({
        ...input,
        identity: {
          ...input.identity,
          runtime_id: randomUUID(),
          incarnation: randomUUID(),
          launch_id: randomUUID(),
        },
      }),
    ).toThrow(/UNIQUE/);
    expect(store.live()).toEqual([first]);
    expect(store.removeEnded(first.runtime_id)).toBe(false);
  });

  it('commits the cursor and application events together, skipping repeated observations', () => {
    const { db, store, input, session } = fixture();
    const binding = store.prepare(input);
    const event = {
      segment: { id: binding.runtime_id, start_cursor: 0, agent_session_ref: null },
      cursor: 4,
      sessionId: session.id,
      conversationId: null,
      state: 'running' as const,
    };
    const apply = vi.fn(() =>
      db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('adopted', session.id),
    );
    expect(store.observe(binding.runtime_id, event, apply)).toBe(true);
    expect(store.observe(binding.runtime_id, event, apply)).toBe(false);
    expect(store.observe(binding.runtime_id, { ...event, cursor: 3 }, apply)).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(store.get(binding.runtime_id)?.event_cursor).toBe(4);
    expect(db.prepare('SELECT title FROM sessions WHERE id = ?').get(session.id)).toEqual({
      title: 'adopted',
    });
  });

  it('rolls back both application effects and the event cursor when reconciliation fails', () => {
    const { db, store, input, session } = fixture();
    const binding = store.prepare(input);
    expect(() =>
      store.observe(
        binding.runtime_id,
        {
          segment: { id: input.identity.runtime_id, start_cursor: 0, agent_session_ref: null },
          cursor: 1,
          sessionId: session.id,
          conversationId: null,
          state: 'running',
        },
        () => {
          db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('incomplete', session.id);
          throw new Error('Reconciliation failed');
        },
      ),
    ).toThrow('Reconciliation failed');
    expect(store.get(binding.runtime_id)).toEqual(binding);
    expect(db.prepare('SELECT title FROM sessions WHERE id = ?').get(session.id)).toEqual({
      title: null,
    });
  });

  it('allows a placement switch only within the original project and canonical worktree', () => {
    const { store, input, createSession, project } = fixture();
    const binding = store.prepare(input);
    const target = createSession(project.id, input.identity.canonical_worktree_path);
    const next = { id: randomUUID(), start_cursor: 1, agent_session_ref: 'next' };
    expect(
      store.observe(
        binding.runtime_id,
        {
          segment: next,
          previousSegmentId: binding.runtime_id,
          cursor: 1,
          sessionId: target.id,
          conversationId: null,
          state: 'running',
        },
        () => {},
      ),
    ).toBe(true);
    expect(store.get(binding.runtime_id)?.active_session_id).toBe(target.id);
    const elsewhere = createSession();
    expect(() =>
      store.observe(
        binding.runtime_id,
        {
          segment: { id: input.identity.runtime_id, start_cursor: 0, agent_session_ref: null },
          cursor: 2,
          sessionId: elsewhere.id,
          conversationId: null,
          state: 'running',
        },
        () => {},
      ),
    ).toThrow(/ownership/);
    expect(store.get(binding.runtime_id)?.event_cursor).toBe(1);
  });

  it('preserves terminal outcomes and creates a fresh identity only for a new launch', () => {
    const { store, input, session } = fixture();
    const first = store.prepare(input);
    expect(
      store.observe(
        first.runtime_id,
        {
          segment: { id: input.identity.runtime_id, start_cursor: 0, agent_session_ref: null },
          cursor: 10,
          sessionId: session.id,
          conversationId: null,
          state: 'exited',
        },
        () => {},
      ),
    ).toBe(true);
    expect(() =>
      store.observe(
        first.runtime_id,
        {
          segment: { id: input.identity.runtime_id, start_cursor: 0, agent_session_ref: null },
          cursor: 11,
          sessionId: session.id,
          conversationId: null,
          state: 'running',
        },
        () => {},
      ),
    ).toThrow(/ended/);
    const apply = vi.fn();
    expect(store.interrupt(first.runtime_id, apply)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    const second = store.prepare({
      ...input,
      identity: {
        ...input.identity,
        runtime_id: randomUUID(),
        incarnation: randomUUID(),
        launch_id: randomUUID(),
      },
    });
    expect(second.runtime_id).not.toBe(first.runtime_id);
    expect(store.live()).toEqual([second]);
    expect(store.removeEnded(first.runtime_id)).toBe(true);
  });

  it('retains the event cursor when confirmed owner loss is recorded once', () => {
    const { store, input, session } = fixture();
    const binding = store.prepare(input);
    store.observe(
      binding.runtime_id,
      {
        segment: { id: input.identity.runtime_id, start_cursor: 0, agent_session_ref: null },
        cursor: 7,
        sessionId: session.id,
        conversationId: null,
        state: 'running',
      },
      () => {},
    );
    const apply = vi.fn();
    expect(store.interrupt(binding.runtime_id, apply)).toBe(true);
    expect(store.interrupt(binding.runtime_id, apply)).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(store.get(binding.runtime_id)).toMatchObject({ state: 'interrupted', event_cursor: 7 });
  });
});
