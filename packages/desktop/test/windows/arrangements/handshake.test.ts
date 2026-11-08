import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  uiStateSnapshotSchema,
  type DesktopWindowCommand,
  type DesktopWorkspaceContent,
} from '@puddle/shared';
import type { ReopenWindow } from '../../../src/reopen.js';
import { DesktopWindowState } from '../../../src/windows/persistence/state.js';
import { WindowCommands } from '../../../src/windows/lifecycle/commands.js';
import { ArrangementParticipant } from '../../../../web/src/features/windows/arrangements/participant.js';
import { DesktopWorkingSet } from '../../../../web/src/features/windows/state/working-set.js';
import { DesktopContentState } from '../../../../web/src/features/windows/state/content-state.js';
import { registerRendererLifecycle } from '../../../../web/src/features/windows/lifecycle/renderer-lifecycle.js';

const profileId = 'aaaaaaaaaa';
const projectId = '1111111111';
const arrangementId = 'arrangement';
const host: ReopenWindow = { target: 'local', window: { kind: 'host', id: 'host' }, route: '/' };
const pane: ReopenWindow = {
  target: 'local',
  window: { kind: 'pane', id: 'pane', profileId, projectId },
  route: `/project/${projectId}`,
};
const replacement: ReopenWindow = { ...pane, window: { ...pane.window!, id: 'replacement' } };
const empty = (): DesktopWorkspaceContent => ({
  snapshot: uiStateSnapshotSchema.parse({}),
  buffers: [],
  views: {},
});
const homes: string[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-layout-handshake-'));
  homes.push(home);
  const file = join(home, 'windows.json');
  const state = new DesktopWindowState(file);
  const commands = new WindowCommands();
  state.syncOpenWindows([host, pane]);
  for (const id of ['host', 'pane'])
    state.write(id, profileId, 0, {
      ...empty(),
      buffers: [{ session: 'session', path: `${id}.ts`, content: `${id} edits`, baseMtimeMs: 1 }],
    });
  async function renderer(id: string) {
    const staging = state.stagingArrangement(id)?.transaction.id;
    const content = new DesktopContentState();
    const owner = new DesktopWorkingSet(
      profileId,
      {
        read: async () => state.readPresentation(id, profileId),
        write: async (request) => state.write(id, profileId, request.revision, request.content),
      },
      content,
      vi.fn(),
      undefined,
      !!staging,
    );
    content.subscribe(() => owner.changed());
    await owner.load(async () => {
      throw new Error('A staged renderer must not create a seed');
    });
    let route = id === 'host' ? '/' : `/project/${projectId}`;
    const environment = {
      activeProfile: () => profileId,
      owner: async () => owner,
      read: async () => state.readPresentation(id, profileId),
      initialArrangement: () => staging,
      staging: vi.fn(),
      fence: vi.fn(),
      suspend: vi.fn((hidden: boolean) => {
        // Simulate the shared Workspace/dashboard mounting after the state swap.
        if (!hidden) queueMicrotask(() => participant.mounted(profileId));
      }),
      route: () => route,
      navigate: (next: string) => {
        route = next;
      },
    };
    const participant = new ArrangementParticipant(environment, 100);
    let receive!: (command: DesktopWindowCommand) => void;
    await registerRendererLifecycle(
      {
        onCommand: (callback) => {
          receive = callback;
          return () => commands.disconnected(id);
        },
        ready: async () => commands.ready(id, (command) => receive(command)),
        reply: async (reply) => commands.reply(id, reply),
      },
      () => [{ checkpoint: () => owner.checkpoint(), resume: () => owner.resumeCheckpoint() }],
      environment.fence,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      (command) => participant.command(command),
    );
    return { owner, content, environment };
  }
  const originals = { host: await renderer('host'), pane: await renderer('pane') };
  const sealed = await Promise.all(
    ['host', 'pane'].map((id) =>
      commands.arrangement(id, {
        kind: 'seal-layout',
        arrangementId,
        profileId,
      }),
    ),
  );
  const changes = [
    { record: host, ...sealed[0]!, open: true },
    { record: pane, revision: sealed[1]!.revision, content: empty(), open: false },
    { record: replacement, revision: 0, content: sealed[1]!.content, open: true },
  ];
  state.prepareArrangement({
    id: arrangementId,
    ownerId: 'host',
    profileId,
    scope: 'profile',
    changes,
  });
  const incoming = await renderer('replacement');
  const stage = (id: string) =>
    commands.arrangement(id, {
      kind: 'stage-layout',
      arrangementId,
      profileId,
      version: state.readPresentation(id, profileId)!,
      route: id === 'host' ? '/' : `/project/${projectId}`,
    });
  const verify = (id: string) =>
    commands.arrangement(id, { kind: 'verify-layout', arrangementId, profileId });
  const finish = (id: string, outcome: 'committed' | 'cancelled') =>
    commands.arrangement(id, {
      kind: 'finish-layout',
      arrangementId,
      profileId,
      outcome,
    });
  return { state, file, originals, incoming, stage, verify, finish };
}

it('coordinates real renderer votes through native commands before atomically changing ownership', async () => {
  const f = await setup();
  await Promise.all([f.stage('host'), f.stage('replacement')]);
  expect(f.state.openWindows().map((record) => record.window?.id)).toEqual(['host', 'pane']);
  expect(f.originals.host.owner.locked()).toBe(true);
  expect(f.incoming.owner.locked()).toBe(true);
  await Promise.all([f.verify('host'), f.verify('pane'), f.verify('replacement')]);
  f.state.commitArrangement(arrangementId, 'host');
  await Promise.all([f.finish('host', 'committed'), f.finish('replacement', 'committed')]);
  expect(f.state.openWindows().map((record) => record.window?.id)).toEqual(['host', 'replacement']);
  expect(f.originals.host.owner.locked()).toBe(false);
  expect(f.incoming.owner.locked()).toBe(false);
  expect(f.originals.pane.owner.locked()).toBe(true); // main may now retire the sealed source
  expect(f.incoming.content.capture().buffers[0]?.content).toBe('pane edits');
  const restarted = new DesktopWindowState(f.file);
  restarted.recoverPending();
  expect(restarted.arrangementOutcome(arrangementId, 'host')).toBe('committed');
  expect(restarted.openWindows()).toEqual(f.state.openWindows());
});

it('cancels every participant after a failed mount and preserves original ownership and drafts on restart', async () => {
  const f = await setup();
  f.incoming.environment.suspend.mockImplementation(() => undefined);
  await f.stage('host');
  const failed = expect(f.stage('replacement')).rejects.toThrow('did not finish mounting');
  await vi.advanceTimersByTimeAsync(101);
  await failed;
  f.state.cancelArrangement(arrangementId, 'host');
  await Promise.all(['host', 'pane', 'replacement'].map((id) => f.finish(id, 'cancelled')));
  expect(f.originals.host.owner.locked()).toBe(false);
  expect(f.originals.pane.owner.locked()).toBe(false);
  expect(f.incoming.owner.locked()).toBe(true);
  const restarted = new DesktopWindowState(f.file);
  restarted.recoverPending();
  expect(restarted.openWindows().map((record) => record.window?.id)).toEqual(['host', 'pane']);
  expect(restarted.read('pane', profileId)?.content.buffers[0]?.content).toBe('pane edits');
  expect(restarted.read('replacement', profileId)).toBeNull();
});
