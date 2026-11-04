import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RUNTIME_PROTOCOL_VERSION, runtimeStateSchema, type RuntimeSegment } from '@puddle/shared';
import { atomicPrivateJson, ipcPath } from '@puddle/shared/node';
import { openDatabase } from '../../../src/db/db.js';
import { ProfileStore } from '../../../src/db/stores/profiles.js';
import { ProjectStore } from '../../../src/db/stores/projects.js';
import { RepoStore } from '../../../src/db/stores/repos.js';
import { AccountStore } from '../../../src/db/stores/accounts.js';
import { ConversationStore } from '../../../src/db/stores/conversations.js';
import { SessionStore } from '../../../src/db/stores/sessions.js';
import { RuntimeStore } from '../../../src/db/stores/runtimes.js';
import { RuntimeClient } from '../../../src/runtime/transport/client.js';
import { readRuntimeFrames, writeRuntimeFrame } from '../../../src/runtime/transport/framing.js';
import {
  acquireRuntimeControllerWhenAvailable,
  readRuntimeJson,
} from '../../../src/runtime/ownership/storage.js';
import {
  clients,
  controllers,
  launchOwner,
  prepare,
  setup,
  terminal,
  waitForOwner,
  waitForSnapshot,
} from '../../helpers/runtime-fixture.js';
import { placement } from '../../helpers/runtime-placement.js';

it('commits native switches before binding, fences stale mutations and recovers an unread binding response', async () => {
  const { home, launch, directory, controller } = prepare('interactive');
  const database = join(home, 'application.db');
  let db = openDatabase(database);
  try {
    const profile = new ProfileStore(db).create({ name: 'binding', branch_prefix: '' });
    const repo = new RepoStore(db).create({
      path: home,
      default_base_branch: 'main',
      onboarding_notes: null,
      fetch_enabled: false,
    });
    const project = new ProjectStore(db).create({
      profile_id: profile.id,
      repo_id: repo.id,
      name: 'binding',
    });
    const account = new AccountStore(db).create({
      profile_id: profile.id,
      agent_type: 'runtime-test',
      label: 'fixture',
      config_dir: home,
      skip_permissions_default: false,
    });
    const sessions = new SessionStore(db);
    const conversations = new ConversationStore(db);
    const createSession = (conversationId: number | null = null) =>
      sessions.create({
        id: randomUUID(),
        project_id: project.id,
        account_id: account.id,
        worktree_path: home,
        base_branch: 'main',
        branch: 'main',
        separate_branch: false,
        kind: 'agent',
        agent_type: 'runtime-test',
        title: null,
        skip_permissions: false,
        conversation_id: conversationId,
      });
    const initial = createSession();
    Object.assign(launch.identity, {
      canonical_worktree_path: realpathSync(home),
      profile_id: profile.id,
      project_id: project.id,
      session_id: initial.id,
    });
    atomicPrivateJson(join(directory, 'launch.json'), launch);
    let store = new RuntimeStore(db);
    store.prepare({
      identity: launch.identity,
      build: 'runtime-test',
      protocol: RUNTIME_PROTOCOL_VERSION,
      releasePath: directory,
    });
    const owner = launchOwner(home, launch.identity.runtime_id, 'provider-owner.mjs');
    await waitForOwner(owner, directory);
    const client = await RuntimeClient.open(home, launch, controller.record);
    clients.push(client);
    const address = placement(client);
    const main = terminal(client.state);
    const initialSidecars = client.state!.agent!.sidecar_pids;
    const hook = readRuntimeJson(join(home, `${initial.id}.signals.json`)) as {
      url: string;
      nonce: string;
    };
    const signal = async (ref: string) => {
      const response = await fetch(hook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nonce: hook.nonce,
          event: 'session_start',
          agent_session_ref: ref,
          cwd: home,
          source: 'clear',
        }),
        signal: AbortSignal.timeout(5000),
      });
      await response.arrayBuffer();
      expect(response.status).toBe(204);
    };
    await signal('first');
    await client.request({
      placement: address,
      t: 'input',
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: "stty -echo; retained=alive; printf 'ready-%s\\n' binding\n",
    });
    await waitForSnapshot(client, main.generation, 'ready-binding');
    await signal('second');
    await client.request({ t: 'inspect' });
    expect(client.state!.binding).toBeNull();
    const current = client.state!.history.current;
    const staleCommands = [
      {
        t: 'input' as const,
        term: 'agent',
        generation: main.generation,
        source: 'human' as const,
        data: 'retained=wrong\n',
      },
      { t: 'resize' as const, term: 'agent', generation: main.generation, cols: 20, rows: 5 },
      { t: 'kill-terminal' as const, term: 'agent', generation: main.generation },
      { t: 'spawn-shell' as const, term: 'shell-1', command: launch.main },
      { t: 'start-turn' as const, turn: 1, expected_ref: 'second', prompt: 'must not run' },
      { t: 'cancel-turn' as const, turn: 1 },
      { t: 'capture-env' as const, enabled: true },
      { t: 'clear-env' as const },
      { t: 'stop' as const },
    ];
    for (const command of staleCommands)
      await expect(client.request({ ...command, placement: address })).rejects.toMatchObject({
        code: 'stale_placement',
      });
    // Knowing the current segment is insufficient: the placement needs a committed binding.
    await expect(
      client.request({ t: 'stop', placement: { segment_id: current.id, session_id: initial.id } }),
    ).rejects.toMatchObject({ code: 'stale_placement' });
    await expect(
      client.request({
        t: 'bind-placement',
        binding: { segment_id: current.id, session_id: initial.id, through: current.start_cursor },
      }),
    ).rejects.toMatchObject({ code: 'stale_placement' });

    const replay = await client.request({ t: 'events', after: 0 });
    if (replay.t !== 'events' || replay.page.gap) throw new Error('Incomplete fixture journal');
    let segment: RuntimeSegment = {
      id: launch.identity.runtime_id,
      start_cursor: 0,
      agent_session_ref: null,
    };
    let sessionId = initial.id;
    let conversationId: number | null = null;
    for (const event of replay.page.events) {
      // This fixture has only terminal/lifecycle events. A production reconciler
      // must also apply environment, exits and turn results before advancing.
      db.transaction(() => {
        if (event.t === 'native-lifecycle') {
          segment = event.segment;
          const conversation = conversations.upsert(profile.id, 'runtime-test', account.id, {
            ref: event.lifecycle.agent_session_ref!,
            cwd: home,
          });
          conversationId = conversation.id;
          if (event.previous_segment_id) sessionId = createSession(conversationId).id;
        }
        store.observe(
          launch.identity.runtime_id,
          {
            cursor: event.cursor,
            sessionId,
            conversationId,
            state: 'running',
            segment,
            ...(event.t === 'native-lifecycle' && event.previous_segment_id
              ? { previousSegmentId: event.previous_segment_id }
              : {}),
          },
          () => {
            db.prepare('UPDATE sessions SET conversation_id = ? WHERE id = ?').run(
              conversationId,
              sessionId,
            );
          },
        );
      })();
    }
    if (replay.page.through > store.get(launch.identity.runtime_id)!.event_cursor)
      store.observe(
        launch.identity.runtime_id,
        {
          cursor: replay.page.through,
          sessionId,
          conversationId,
          state: 'running',
          segment,
        },
        () => {},
      );
    const committed = store.placementBinding(launch.identity.runtime_id);
    expect(committed).toMatchObject({ segment_id: current.id, session_id: sessionId });
    expect(sessionId).not.toBe(initial.id);
    expect(store.segment(launch.identity.runtime_id, address.segment_id)?.end_cursor).toBe(
      current.start_cursor - 1,
    );
    db.close();
    client.close();

    // The binding is dispatched only after the database commit. Deliberately stop
    // reading before dispatch so its reply can never authorise a retry.
    const socket = connect(ipcPath(home, `runtime:${launch.identity.runtime_id}`));
    await once(socket, 'connect');
    try {
      const hello = new Promise<number>((resolve, reject) => {
        const stop = readRuntimeFrames(
          socket,
          (value) => {
            const response = value as { t: string; state?: { command_cursor: number } };
            if (response.t !== 'state') return;
            socket.pause();
            stop();
            resolve(response.state!.command_cursor);
          },
          reject,
        );
      });
      writeRuntimeFrame(socket, {
        t: 'hello',
        id: randomUUID(),
        protocol: RUNTIME_PROTOCOL_VERSION,
        runtime_id: launch.identity.runtime_id,
        incarnation: launch.identity.incarnation,
        secret: launch.secret,
        controller_id: controller.record.id,
        controller_epoch: controller.record.epoch,
      });
      const sequence = await hello;
      // This connection must read events too. A read on the previous socket
      // does not grant acknowledgement authority to its replacement.
      writeRuntimeFrame(socket, {
        t: 'events',
        id: randomUUID(),
        sequence: sequence + 1,
        after: 0,
      });
      writeRuntimeFrame(socket, {
        t: 'bind-placement',
        id: randomUUID(),
        sequence: sequence + 2,
        binding: committed,
      });
      const deadline = Date.now() + 5000;
      while (
        runtimeStateSchema.parse(readRuntimeJson(join(directory, 'state.json'))).binding
          ?.segment_id !== current.id
      ) {
        if (Date.now() > deadline) throw new Error('Runtime did not accept committed binding');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      socket.destroy();
    }
    controller.release();
    const replacement = await acquireRuntimeControllerWhenAvailable(home);
    controllers.push(replacement);
    db = openDatabase(database);
    store = new RuntimeStore(db);
    const next = await RuntimeClient.open(home, launch, replacement.record);
    clients.push(next);
    expect(next.state!.binding).toEqual(store.placementBinding(launch.identity.runtime_id));
    const wrongConversation = new ConversationStore(db).upsert(
      profile.id,
      'runtime-test',
      account.id,
      { ref: 'unrelated', cwd: home },
    );
    expect(() =>
      store.observe(
        launch.identity.runtime_id,
        {
          cursor: committed.through + 1,
          sessionId,
          conversationId: wrongConversation.id,
          state: 'running',
          segment: { ...current, agent_session_ref: 'unrelated' },
        },
        () => {},
      ),
    ).toThrow(/immutable/);
    expect(store.placementBinding(launch.identity.runtime_id)).toEqual(committed);
    expect(terminal(next.state).pid).toBe(main.pid);
    expect(next.state!.agent!.sidecar_pids).toEqual(initialSidecars);
    expect(next.state!.turn).toBeNull();
    expect(next.state!.environment.enabled).toBe(false);
    expect(next.state!.terminals).toHaveLength(1);
    expect(terminal(next.state)).toMatchObject({ cols: 80, rows: 24 });
    await expect(next.request({ t: 'stop', placement: address })).rejects.toMatchObject({
      code: 'stale_placement',
    });
    const page = await next.request({ t: 'events', after: 0 });
    if (page.t !== 'events') throw new Error('Missing retained journal');
    await expect(
      next.request({ t: 'bind-placement', binding: { ...committed, session_id: randomUUID() } }),
    ).rejects.toMatchObject({ code: 'stale_placement' });
    await next.request({ t: 'ack-events', through: committed.through });
    await next.request({
      placement: placement(next),
      t: 'input',
      term: 'agent',
      generation: main.generation,
      source: 'human',
      data: 'printf \'retained-%s\\n\' "$retained"\n',
    });
    await waitForSnapshot(next, main.generation, 'retained-alive');
  } finally {
    if (db.open) db.close();
  }
});

it.each(['capture-env', 'clear-env', 'start-turn'] as const)(
  'rechecks placement when %s admission yields across a native switch',
  async (kind) => {
    const { home, launch, client } = await setup('interactive');
    const hook = readRuntimeJson(join(home, `${launch.identity.session_id}.signals.json`)) as {
      url: string;
      nonce: string;
    };
    const signal = async (ref: string) => {
      const response = await fetch(hook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nonce: hook.nonce,
          event: 'session_start',
          agent_session_ref: ref,
          cwd: home,
          source: 'clear',
        }),
        signal: AbortSignal.timeout(5000),
      });
      await response.arrayBuffer();
      expect(response.status).toBe(204);
    };
    await signal('before');
    await client.request({ t: 'events', after: 0 });
    await client.request({ t: 'inspect' });
    const gate = join(home, 'journal-admission-gate.json');
    atomicPrivateJson(gate, { command: client.state!.command_cursor + 1 });
    const address = placement(client);
    const request =
      kind === 'start-turn'
        ? { t: kind, placement: address, turn: 1, expected_ref: 'before', prompt: 'never dispatch' }
        : kind === 'capture-env'
          ? { t: kind, placement: address, enabled: true }
          : { t: kind, placement: address };
    const rejected = expect(client.request(request)).rejects.toMatchObject({
      code: 'stale_placement',
    });
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(join(home, 'journal-admission-entered.json'))) {
        if (Date.now() > deadline) throw new Error('Command did not reach journal admission');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await signal('after');
    } finally {
      rmSync(gate, { force: true });
    }
    await rejected;
    const replay = await client.request({ t: 'events', after: 0 });
    if (replay.t !== 'events') throw new Error('Missing events');
    expect(
      replay.page.events.some((event) =>
        ['capture-env', 'clear-env', 'turn-started'].includes(event.t),
      ),
    ).toBe(false);
    await client.request({ t: 'inspect' });
    expect(client.state).toMatchObject({
      binding: null,
      turn: null,
      environment: { enabled: false },
      agent: { agent_session_ref: 'after' },
    });
  },
);
