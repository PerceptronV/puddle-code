import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, vi } from 'vitest';
import type { RuntimeNativeTurnRecord, Session } from '@puddle/shared';
import type { RuntimeBinding } from '../../../src/db/stores/runtimes.js';
import type { RuntimeClient } from '../../../src/runtime/transport/client.js';
import { RuntimeNativeTurnJournal } from '../../../src/runtime/state/native-turns/journal.js';
import { HuddleCompletionBaselines } from '../../../src/huddle/triggers/completions/baselines.js';
import { HuddleCompletionDispatcher } from '../../../src/huddle/triggers/completions/dispatcher.js';
import { completionOwnerFixture, untilCompletionOwner } from './completion-owner.js';
import { completionReaderFixture } from './completion-reader.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Real independent huddle owner and native journal; controlled native transport, no provider. */
export async function completionDispatcherFixture(maxRecords = 128) {
  const owner = await completionOwnerFixture(),
    native = completionReaderFixture(),
    scope = owner.launch.scope,
    identity = owner.launch.identity;
  Object.assign(native.state.identity, {
    profile_id: scope.profileId,
    project_id: scope.projectId,
    canonical_worktree_path: owner.home,
  });
  Object.assign(native.binding, {
    profile_id: scope.profileId,
    project_id: scope.projectId,
    canonical_worktree_path: owner.home,
    active_session_id: owner.baseline.target.sessionId,
  });
  Object.assign(native.session, {
    id: owner.baseline.target.sessionId,
    project_id: scope.projectId,
    worktree_path: owner.home,
  });
  native.state.binding!.session_id = native.session.id;
  Object.assign(native.project, { id: scope.projectId, profile_id: scope.profileId });
  const huddle = {
    id: scope.sessionId,
    kind: 'huddle',
    huddle_id: scope.huddleId,
    project_id: scope.projectId,
    worktree_path: owner.home,
    status: 'running',
  } as Session;
  const binding = {
    role: 'huddle',
    state: 'running',
    huddle_id: scope.huddleId,
    runtime_id: identity.runtime_id,
    incarnation: identity.incarnation,
    launch_id: identity.launch_id,
    launch_session_id: identity.session_id,
    active_session_id: identity.session_id,
    profile_id: identity.profile_id,
    project_id: identity.project_id,
    canonical_worktree_path: owner.home,
  } as RuntimeBinding;
  const directory = join(owner.home, 'native-source');
  mkdirSync(directory, { mode: 0o700 });
  const journal = new RuntimeNativeTurnJournal(directory, native.state.identity, undefined, {
    maxRecords,
  });
  expect(await journal.flush()).toBe(true);
  native.state.native_turns = journal.status();
  native.request.mockImplementation(async (command) => {
    native.state.native_turns = journal.status();
    if (command.t === 'inspect') return { t: 'state', id: randomUUID(), state: native.state };
    if (command.t === 'native-turns')
      return { t: 'native-turns', id: randomUUID(), page: journal.read(command.after) };
    throw new Error('Unexpected native mutation');
  });
  const connections = Object.assign(new EventEmitter(), {
    get: vi.fn((): RuntimeClient | undefined => native.client),
    getHuddle: vi.fn((id: string) => (id === binding.runtime_id ? owner.client : undefined)),
  });
  const deps = {
    home: owner.home,
    ...native.deps,
    connections,
    sessions: { get: (id: string) => (id === huddle.id ? huddle : native.session) },
    runtimes: {
      ...native.deps.runtimes,
      ownerOf: (id: string) => (id === huddle.id ? binding : native.binding),
      get: (id: string) => (id === binding.runtime_id ? binding : native.binding),
      live: () => [binding, native.binding],
    },
  };
  const dispatchers: HuddleCompletionDispatcher[] = [];
  const createDispatcher = () => {
    const dispatcher = new HuddleCompletionDispatcher(deps);
    dispatchers.push(dispatcher);
    return dispatcher;
  };
  cleanups.push(async () => {
    for (const dispatcher of dispatchers) await dispatcher.close();
    await journal.close();
    native.close();
  });
  const arm = async () => {
    await owner.client.request({ t: 'inspect' });
    const state = owner.client.state!;
    const captured = await new HuddleCompletionBaselines(deps).capture(
      owner.client,
      state,
      undefined,
      () => {},
    );
    captured.check();
    await owner.client.request({
      t: 'arm',
      expectedGeneration: state.control.generation,
      autoStart: false,
      completionBaselines: captured.baselines,
    });
  };
  const append = async (patch: Partial<RuntimeNativeTurnRecord> = {}) => {
    expect(
      journal.append({
        event: 'completed',
        observedAt: new Date().toISOString(),
        sessionId: native.session.id,
        segmentId: native.binding.active_segment_id!,
        agentSessionRef: 'native-ref',
        nativeTurnId: randomUUID(),
        reply: 'native reply',
        origin: { kind: 'external' },
        ...patch,
      }),
    ).toBe(true);
    expect(await journal.flush()).toBe(true);
  };
  const completed = async (count: number) => {
    await untilCompletionOwner(async () => {
      const response = await owner.client.request({
        t: 'records',
        collection: 'executions',
        after: 0,
      });
      if (response.t !== 'records') throw new Error('Unexpected records response');
      const records = response.rows.map((row) => JSON.parse(row.body));
      const failed = records.find((record) => ['failed', 'interrupted'].includes(record.state));
      if (failed) throw new Error(JSON.stringify(failed));
      expect(records.length).toBeLessThanOrEqual(count);
      return records.length === count && records.every((record) => record.state === 'completed');
    });
  };
  return { owner, native, connections, deps, journal, createDispatcher, arm, append, completed };
}
