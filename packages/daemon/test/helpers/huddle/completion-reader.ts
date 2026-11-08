import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { RuntimeState, Session, Project, RuntimeNativeTurnPage } from '@puddle/shared';
import type { RuntimeBinding } from '../../../src/db/stores/runtimes.js';
import type { RuntimeClient } from '../../../src/runtime/transport/client.js';
import { HuddleCompletionReader } from '../../../src/huddle/triggers/completions/reader.js';

/** Controlled identity/authority changes around real reader awaits; no provider execution. */
export function completionReaderFixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-completion-reader-')));
  const scope = { profileId: '0123456789', projectId: 'abcdef1234' };
  const sessionId = randomUUID(),
    segmentId = randomUUID();
  const identity = {
    runtime_id: randomUUID(),
    incarnation: randomUUID(),
    launch_id: randomUUID(),
    session_id: randomUUID(),
    profile_id: scope.profileId,
    project_id: scope.projectId,
    canonical_worktree_path: home,
  };
  const state = {
    identity,
    protocol: { major: 1, minor: 2 },
    state: 'running',
    persistence_pending: false,
    binding: { session_id: sessionId, segment_id: segmentId, through: 1 },
    history: {
      current: { id: segmentId, agent_session_ref: 'native-ref', start_cursor: 1 },
      gap: false,
      pending_checkpoints: 0,
    },
    agent: {
      native_turn_events: 1,
      provider: 'fixture',
      status: 'running',
      agent_session_ref: 'native-ref',
      control_ready: false,
      native_sync: 'full',
      sidecar_pids: [],
      hidden_ports: [],
    },
    native_turns: {
      version: 1,
      cursor: { epoch: 'a'.repeat(32), sequence: 10 },
      floor: 0,
      persistencePending: false,
    },
  } as RuntimeState;
  const session = {
    id: sessionId,
    kind: 'agent',
    project_id: scope.projectId,
    worktree_path: home,
    status: 'running',
    agent_session_ref: 'native-ref',
  } as Session;
  const project = { id: scope.projectId, profile_id: scope.profileId, archived: false } as Project;
  const binding = {
    role: 'session',
    runtime_id: identity.runtime_id,
    incarnation: identity.incarnation,
    launch_id: identity.launch_id,
    launch_session_id: identity.session_id,
    active_session_id: sessionId,
    active_segment_id: segmentId,
    profile_id: scope.profileId,
    project_id: scope.projectId,
    canonical_worktree_path: home,
    state: 'running',
  } as RuntimeBinding;
  let page: RuntimeNativeTurnPage = {
    state: 'baseline',
    cursor: state.native_turns!.cursor,
    persistencePending: false,
  };
  let onRequest: (t: string) => void = () => {};
  const request = vi.fn<RuntimeClient['request']>(async (command) => {
    onRequest(command.t);
    if (command.t === 'inspect') return { t: 'state', id: randomUUID(), state };
    if (command.t === 'native-turns') return { t: 'native-turns', id: randomUUID(), page };
    throw new Error('Reader attempted a non-observation command');
  });
  const client = { state, request } as unknown as RuntimeClient;
  const connections = { get: vi.fn(() => client) };
  const runtimes = { ownerOf: vi.fn(() => binding), stopRequested: vi.fn(() => false) };
  const deps = {
    connections,
    runtimes,
    sessions: { get: vi.fn(() => session) },
    projects: { get: vi.fn(() => project) },
  };
  const reader = new HuddleCompletionReader(deps);
  const selection = { node: 'run', session: sessionId, worktree: home };
  return {
    scope,
    state,
    session,
    project,
    binding,
    client,
    deps,
    reader,
    selection,
    request,
    onRequest: (callback: typeof onRequest) => {
      onRequest = callback;
    },
    setPage: (value: RuntimeNativeTurnPage) => {
      page = value;
    },
    close: () => rmSync(home, { recursive: true, force: true }),
  };
}
