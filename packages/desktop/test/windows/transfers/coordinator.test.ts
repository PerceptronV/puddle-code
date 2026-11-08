import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  uiStateSnapshotSchema,
  type DesktopPaneDetach,
  type DesktopWindowTransferCommand,
} from '@puddle/shared';
import type { ReopenWindow } from '../../../src/reopen.js';
import { DesktopWindowState } from '../../../src/windows/persistence/state.js';
import { WindowTransfers } from '../../../src/windows/transfers/coordinator.js';

const homes: string[] = [];
const profileId = '1234567890';
const request: DesktopPaneDetach = {
  id: 'move',
  profileId,
  projectId: 'abcdef1234',
  revision: 1,
  source: { snapshot: uiStateSnapshotSchema.parse({}), buffers: [], views: {} },
  destination: {
    snapshot: uiStateSnapshotSchema.parse({
      layout_mode: 'profile',
      layout_tree: { kind: 'leaf', id: 'pane', tabs: [], activeKey: null },
    }),
    buffers: [{ session: 's', path: 'draft.ts', content: 'unsaved text', baseMtimeMs: 1 }],
    views: {},
  },
};
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-transfers-'));
  homes.push(home);
  const state = new DesktopWindowState(join(home, 'state.json'));
  const source: ReopenWindow = { target: 'local', window: { kind: 'host', id: 'source' } };
  state.syncOpenWindows([source]);
  state.write('source', profileId, 0, request.destination);
  const open = vi.fn(async (_record: ReopenWindow) => undefined);
  const dismiss = vi.fn();
  const transfers = new WindowTransfers({
    state: () => state,
    record: () => source,
    open,
    dismiss,
    report: vi.fn(),
    timeoutMs: 100,
  });
  const destinationId = () => open.mock.calls[0]![0].window!.id;
  return { state, transfers, open, dismiss, destinationId };
}
afterEach(() => {
  vi.useRealTimers();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

it('keeps source ownership until destination readiness and source confirmation both arrive', async () => {
  const { state, transfers, destinationId } = setup();
  const prepared = transfers.preparePane('source', request);
  expect(state.read('source', profileId)?.content.buffers).toEqual(request.destination.buffers);
  expect(state.read(destinationId(), profileId)).toBeNull();
  expect(state.readPresentation(destinationId(), profileId)?.content).toEqual(request.destination);
  expect(() => transfers.commit('source', request)).toThrow('not accepted');
  expect(() => transfers.accept('sibling', request)).toThrow('another window');
  const accepted = transfers.accept(destinationId(), request);
  await prepared;
  expect(state.outcome(request.id)).toBe('prepared');
  expect(() => transfers.commit('source', { ...request, profileId: '0000000000' })).toThrow(
    'another profile',
  );
  expect(transfers.commit('source', request).content).toEqual(request.source);
  expect((await accepted).content).toEqual(request.destination);
  expect(state.outcome(request.id)).toBe('committed');
  expect(transfers.commit('source', request).revision).toBe(2);
  expect(state.openWindows()).toHaveLength(2);
  expect(state.openWindows()[0]!.route).toBe('/project/abcdef1234');
});

it('lets either transfer participant observe its own committed revision without granting mutation rights', async () => {
  const { transfers, destinationId } = setup();
  const prepared = transfers.preparePane('source', request);
  const accepted = transfers.accept(destinationId(), request);
  await prepared;
  transfers.commit('source', request);
  await accepted;
  expect(transfers.observe(destinationId(), request)).toMatchObject({
    status: 'committed',
    version: { content: request.destination },
  });
  expect(transfers.observe('source', request)).toMatchObject({
    status: 'committed',
    version: { content: request.source },
  });
  expect(() => transfers.observe('sibling', request)).toThrow('another window');
  expect(() => transfers.observe(destinationId(), { ...request, profileId: '0000000000' })).toThrow(
    'another profile',
  );
  expect(() => transfers.commit(destinationId(), request)).toThrow('another window');
  expect(() => transfers.cancel(destinationId(), request)).toThrow('another window');
});

it('rolls back a destination launch failure without removing source drafts', async () => {
  const { state, transfers, open, dismiss } = setup();
  open.mockRejectedValue(new Error('Window creation failed'));
  await expect(transfers.preparePane('source', request)).rejects.toThrow('creation failed');
  expect(state.outcome(request.id)).toBe('cancelled');
  expect(state.openWindows()).toHaveLength(1);
  expect(state.read('source', profileId)?.content.buffers).toEqual(request.destination.buffers);
  expect(dismiss).toHaveBeenCalledOnce();
});

it('opens an entire project through the same two-party acknowledgement and refuses duplicate owners', async () => {
  const { state, transfers, destinationId, open } = setup();
  const prepared = transfers.prepareProject('source', request);
  expect(open.mock.calls[0]![0].window?.kind).toBe('project');
  expect(state.projectWindow('source', profileId, request.projectId)?.open).toBe(false);
  expect(() => transfers.prepareProject('source', { ...request, id: 'duplicate' })).toThrow(
    'already has a window',
  );
  const accepted = transfers.accept(destinationId(), request);
  await prepared;
  expect(state.outcome('move')).toBe('prepared');
  transfers.commit('source', request);
  await accepted;
  expect(state.openWindows().find((record) => record.window?.id === 'source')?.route).toBe('/');
});

function returnedProject() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-project-return-'));
  homes.push(home);
  const file = join(home, 'state.json');
  const state = new DesktopWindowState(file);
  const source: ReopenWindow = {
    target: 'local',
    window: { kind: 'project', id: 'closed-project', profileId, projectId: request.projectId },
  };
  const destination: ReopenWindow = {
    target: 'local',
    window: { kind: 'host', id: 'host' },
    route: '/',
  };
  state.syncOpenWindows([source, destination]);
  state.write('closed-project', profileId, 0, request.destination);
  state.write('host', profileId, 0, request.source);
  state.closeProject('closed-project', 1);
  state.syncOpenWindows([destination]);
  const command = vi.fn(async (_id: string, command: DesktopWindowTransferCommand) =>
    command.kind === 'plan-project' ? { revision: 1, content: request.destination } : undefined,
  );
  const transfers = new WindowTransfers({
    state: () => state,
    record: (id) => {
      if (id !== 'host') throw new Error('No live source renderer');
      return destination;
    },
    open: vi.fn(),
    dismiss: vi.fn(),
    report: vi.fn(),
    command,
    timeoutMs: 1000,
  });
  const pending = async () => {
    await vi.waitFor(() => expect(state.staging('host')).not.toBeNull());
    return { id: state.staging('host')!.id, profileId };
  };
  return { state, file, transfers, command, pending };
}

it('returns a closed project using its durable capture without requiring a live source window', async () => {
  const f = returnedProject();
  const route = `/project/${request.projectId}/session/00000000-0000-4000-8000-000000000001`;
  const prepared = f.transfers.restoreProject('closed-project', 'host', profileId, route);
  const reference = await f.pending();
  expect(f.transfers.busy('closed-project')).toBe(true);
  expect(f.state.returnedProject('closed-project')?.version.revision).toBe(1);
  expect(() => f.state.reopenProject('closed-project')).toThrow('transfer is pending');
  const accepted = await f.transfers.accept('host', reference);
  await prepared;
  expect(accepted.content).toEqual(request.destination);
  expect(f.state.outcome(reference.id)).toBe('committed');
  expect(f.state.read('closed-project', profileId)?.content.buffers).toEqual([]);
  expect(f.state.returnedProject('closed-project')).toBeNull();
  expect(f.state.openWindows()).toEqual([
    { target: 'local', window: { kind: 'host', id: 'host' }, route },
  ]);
  expect(f.transfers.busy('closed-project')).toBe(false);
  expect((await f.transfers.accept('host', reference)).revision).toBe(2);
  expect(
    f.command.mock.calls.filter(([, command]) => command.kind === 'plan-project'),
  ).toHaveLength(1);
});

it('retains the closed project after a destination failure and across interrupted preparation recovery', async () => {
  const f = returnedProject();
  const prepared = f.transfers.restoreProject(
    'closed-project',
    'host',
    profileId,
    `/project/${request.projectId}`,
  );
  const reference = await f.pending();
  const recovered = new DesktopWindowState(f.file);
  recovered.recoverPending();
  expect(recovered.returnedProject('closed-project')?.version.content).toEqual(request.destination);
  expect(recovered.read('host', profileId)?.content).toEqual(request.source);
  f.transfers.disconnected('host');
  await expect(prepared).rejects.toThrow('disconnected');
  expect(f.state.returnedProject('closed-project')?.version.content).toEqual(request.destination);
  expect(f.state.outcome(reference.id)).toBe('cancelled');
  expect(f.command).toHaveBeenCalledWith('host', {
    kind: 'cancel-window',
    transferId: reference.id,
    profileId,
  });
});

it('rechecks the closed source after planning and does not move a project reopened in the meantime', async () => {
  const f = returnedProject();
  let complete!: (value: { revision: number; content: typeof request.destination }) => void;
  f.command.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const prepared = f.transfers.restoreProject(
    'closed-project',
    'host',
    profileId,
    `/project/${request.projectId}`,
  );
  f.state.reopenProject('closed-project');
  complete({ revision: 1, content: request.destination });
  await expect(prepared).rejects.toThrow('returned project changed');
  expect(f.state.read('host', profileId)?.content).toEqual(request.source);
  expect(f.state.read('closed-project', profileId)?.content).toEqual(request.destination);
});

it('leaves the returned project recoverable if committing its destination fails', async () => {
  const f = returnedProject();
  const prepared = f.transfers.restoreProject(
    'closed-project',
    'host',
    profileId,
    `/project/${request.projectId}`,
  );
  const reference = await f.pending();
  vi.spyOn(f.state, 'commit').mockImplementationOnce(() => {
    throw new Error('disk full');
  });
  await expect(f.transfers.accept('host', reference)).rejects.toThrow('disk full');
  await expect(prepared).rejects.toThrow('disk full');
  expect(f.state.returnedProject('closed-project')?.version.content).toEqual(request.destination);
  expect(f.state.read('host', profileId)?.content).toEqual(request.source);
  expect(f.state.outcome(reference.id)).toBe('cancelled');
});

it('cancels a prepared destination if the source disappears before committing', async () => {
  const { state, transfers, destinationId } = setup();
  const prepared = transfers.preparePane('source', request);
  const accepted = transfers.accept(destinationId(), request);
  await prepared;
  transfers.disconnected('source');
  await expect(accepted).rejects.toThrow('disconnected');
  expect(state.outcome(request.id)).toBe('cancelled');
  expect(() => transfers.commit('source', request)).toThrow('not accepted');
});

it('times out missing destination readiness and never redispatches the move', async () => {
  vi.useFakeTimers();
  const { state, transfers, open } = setup();
  const pending = expect(transfers.preparePane('source', request)).rejects.toThrow('in time');
  await vi.advanceTimersByTimeAsync(100);
  await pending;
  expect(open).toHaveBeenCalledOnce();
  expect(transfers.observe('source', request).status).toBe('cancelled');
  expect(state.read('source', profileId)?.revision).toBe(1);
});

function docking(tab = false, project = false) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-docking-'));
  homes.push(home);
  const file = join(home, 'state.json');
  const state = new DesktopWindowState(file);
  const source: ReopenWindow = {
    target: 'local',
    window: project
      ? { kind: 'project', id: 'source', profileId, projectId: request.projectId }
      : tab
        ? { kind: 'host', id: 'source' }
        : { kind: 'pane', id: 'source', profileId, projectId: request.projectId },
  };
  const destination: ReopenWindow = {
    target: 'local',
    window: tab
      ? { kind: 'pane', id: 'destination', profileId, projectId: '0000000001' }
      : { kind: 'host', id: 'destination' },
    route: '/project/0000000001',
  };
  state.syncOpenWindows([source, destination]);
  state.write('source', profileId, 0, request.destination);
  state.write('destination', profileId, 0, request.source);
  const command = vi.fn(async (_id: string, command: DesktopWindowTransferCommand) =>
    command.kind === 'plan-pane' || command.kind === 'plan-project'
      ? { revision: 1, content: request.destination }
      : undefined,
  );
  const dismiss = vi.fn();
  const open = vi.fn();
  const transfers = new WindowTransfers({
    state: () => state,
    record: (id) => (id === 'source' ? source : destination),
    command,
    dismiss,
    open,
    report: vi.fn(),
    timeoutMs: 1000,
  });
  return {
    file,
    state,
    transfers,
    command,
    dismiss,
    open,
    source,
    destination,
    request: { ...request, destinationId: 'destination' },
  };
}

it('docks into an existing revision and retires only an empty acknowledged source', async () => {
  const f = docking();
  const prepared = f.transfers.prepareDock('source', f.request);
  await vi.waitFor(() => expect(f.state.outcome('move')).toBe('prepared'));
  const accepted = f.transfers.accept('destination', request);
  await prepared;
  f.state.syncOpenWindows([f.source, { ...f.destination, route: '/project/abcdef1234' }]);
  expect(f.state.openWindows().find((record) => record.window?.id === 'destination')?.route).toBe(
    '/project/0000000001',
  );
  expect(f.state.read('source', profileId)?.content.buffers).toEqual(request.destination.buffers);
  expect(f.state.read('destination', profileId)?.content.buffers).toEqual([]);
  expect(() => f.transfers.retire('source', { ...request, revision: 1 })).toThrow('not committed');
  f.transfers.commit('source', request);
  await accepted;
  expect(f.state.openWindows().find((record) => record.window?.id === 'destination')?.route).toBe(
    '/project/abcdef1234',
  );
  expect(() => f.transfers.retire('source', { ...request, revision: 1 })).toThrow('state changed');
  f.transfers.retire('source', { ...request, revision: 2 });
  expect(f.dismiss).toHaveBeenCalledWith('source');
  expect(f.state.openWindows().map((record) => record.window?.id)).toEqual(['destination']);
  expect(f.open).not.toHaveBeenCalled();
});

it('returns a live project only after both acknowledgements and closes its ownership atomically', async () => {
  const f = docking(false, true);
  const input = {
    ...f.request,
    source: {
      ...f.request.source,
      snapshot: uiStateSnapshotSchema.parse({
        layout_mode: 'profile',
        layout_tree: { kind: 'leaf', id: 'empty', tabs: [], activeKey: null },
      }),
    },
  };
  const prepared = f.transfers.prepareProjectDock('source', input);
  await vi.waitFor(() => expect(f.state.outcome(input.id)).toBe('prepared'));
  expect(f.command).toHaveBeenCalledWith(
    'destination',
    expect.objectContaining({ kind: 'plan-project', projectId: input.projectId }),
  );
  expect(f.dismiss).not.toHaveBeenCalled();
  const accepted = f.transfers.accept('destination', input);
  await prepared;
  expect(f.state.openWindows()).toHaveLength(2);
  // Interruption before source confirmation restores original ownership.
  const beforeCommit = new DesktopWindowState(f.file);
  expect(beforeCommit.projectWindow('destination', profileId, input.projectId)?.open).toBe(true);
  expect(beforeCommit.read('source', profileId)?.content.buffers).toEqual(
    request.destination.buffers,
  );
  f.transfers.commit('source', input);
  await accepted;
  expect(f.dismiss).toHaveBeenCalledExactlyOnceWith('source');
  expect(f.state.openWindows()).toEqual([
    { ...f.destination, route: `/project/${input.projectId}` },
  ]);
  expect(f.state.projectWindow('destination', profileId, input.projectId)).toBeNull();
  expect(f.state.read('destination', profileId)?.content.buffers).toEqual(
    request.destination.buffers,
  );
  // The durable commit already excludes the project, even if native dismissal
  // or the acknowledgement was lost immediately afterwards.
  const afterCommit = new DesktopWindowState(f.file);
  expect(afterCommit.openWindows()).toEqual(f.state.openWindows());
  expect(afterCommit.projectWindow('destination', profileId, input.projectId)).toBeNull();
  expect(afterCommit.read('destination', profileId)?.content.buffers).toEqual(
    request.destination.buffers,
  );
  f.transfers.commit('source', input);
  expect(f.dismiss).toHaveBeenCalledOnce();
});

it('keeps the original project open after a failed return and rejects sources that retain content', async () => {
  const f = docking(false, true);
  expect(() => f.transfers.prepareProjectDock('source', f.request)).toThrow(
    'release all its content',
  );
  const input = {
    ...f.request,
    source: {
      ...f.request.source,
      snapshot: uiStateSnapshotSchema.parse({
        layout_mode: 'profile',
        layout_tree: { kind: 'leaf', id: 'empty', tabs: [], activeKey: null },
      }),
    },
  };
  const prepared = f.transfers.prepareProjectDock('source', input);
  await vi.waitFor(() => expect(f.state.outcome(input.id)).toBe('prepared'));
  f.transfers.disconnected('destination');
  await expect(prepared).rejects.toThrow('disconnected');
  expect(f.dismiss).not.toHaveBeenCalled();
  expect(f.state.projectWindow('destination', profileId, input.projectId)?.open).toBe(true);
  expect(f.state.read('source', profileId)?.content.buffers).toEqual(request.destination.buffers);
});

it('stages a host tab in a pane window using its fixed anchor and preserves the source route', async () => {
  const f = docking(true);
  f.command.mockImplementation(async (_id, command) =>
    command.kind === 'plan-tab' ? { revision: 1, content: request.destination } : undefined,
  );
  const prepared = f.transfers.prepareTabDock('source', {
    ...f.request,
    sourceRoute: '/project/abcdef1234',
    destinationProjectId: '0000000002',
    placement: { paneId: 'target', edge: 'center' },
  });
  await vi.waitFor(() => expect(f.state.outcome('move')).toBe('prepared'));
  expect(f.command).toHaveBeenCalledWith(
    'destination',
    expect.objectContaining({
      kind: 'plan-tab',
      projectId: '0000000001',
      placement: { paneId: 'target', edge: 'center' },
    }),
  );
  const accepted = f.transfers.accept('destination', request);
  await prepared;
  f.transfers.commit('source', request);
  await accepted;
  expect(f.state.openWindows().find((record) => record.window?.id === 'source')?.route).toBe(
    '/project/abcdef1234',
  );
  expect(f.state.openWindows()).toHaveLength(2);
  expect(f.dismiss).not.toHaveBeenCalled();
});

it('restores an existing destination after a staging failure without destroying either window', async () => {
  const f = docking();
  f.command.mockImplementation(async (_id, command) => {
    if (command.kind === 'stage-window') throw new Error('Mount failed');
    return command.kind === 'plan-pane' ? { revision: 1, content: request.destination } : undefined;
  });
  await expect(f.transfers.prepareDock('source', f.request)).rejects.toThrow('Mount failed');
  expect(f.state.outcome('move')).toBe('cancelled');
  expect(f.state.openWindows()).toHaveLength(2);
  expect(f.state.read('source', profileId)?.revision).toBe(1);
  expect(f.state.read('destination', profileId)?.revision).toBe(1);
  expect(f.dismiss).not.toHaveBeenCalled();
  expect(f.command).toHaveBeenLastCalledWith('destination', {
    kind: 'cancel-window',
    transferId: 'move',
    profileId,
  });
});

it('releases destination presentation work when its renderer crashes during docking', async () => {
  const f = docking();
  const prepared = f.transfers.prepareDock('source', f.request);
  await vi.waitFor(() => expect(f.state.outcome('move')).toBe('prepared'));
  f.command.mockRejectedValue(new Error('Window renderer is unavailable'));
  f.transfers.disconnected('destination');
  await expect(prepared).rejects.toThrow('disconnected');
  expect(f.state.outcome('move')).toBe('cancelled');
  expect(f.state.read('source', profileId)?.content).toEqual(request.destination);
  expect(f.state.read('destination', profileId)?.content).toEqual(request.source);
  expect(f.transfers.busy('destination')).toBe(false);
  expect(f.transfers.presentationPending('destination')).toBe(false);
});

it('keeps a surviving destination busy until its rollback finishes after a source crash', async () => {
  const f = docking();
  const restored = Promise.withResolvers<undefined>();
  const prepared = f.transfers.prepareDock('source', f.request);
  await vi.waitFor(() => expect(f.state.outcome('move')).toBe('prepared'));
  f.command.mockImplementation(() => restored.promise);
  f.transfers.disconnected('source');
  await expect(prepared).rejects.toThrow('disconnected');
  expect(f.transfers.busy('source')).toBe(false);
  expect(f.transfers.busy('destination')).toBe(true);
  expect(f.transfers.presentationPending('destination')).toBe(true);
  restored.resolve(undefined);
  await vi.waitFor(() => expect(f.transfers.busy('destination')).toBe(false));
});

it('positions a drop in the visible destination project without changing the source anchor', async () => {
  const f = docking();
  const destinationProjectId = '0000000001';
  const placement = { paneId: 'target-pane', edge: 'bottom' as const };
  const prepared = f.transfers.prepareDock('source', {
    ...f.request,
    destinationProjectId,
    placement,
  });
  await vi.waitFor(() => expect(f.state.outcome('move')).toBe('prepared'));
  expect(f.command).toHaveBeenCalledWith(
    'destination',
    expect.objectContaining({
      kind: 'plan-pane',
      projectId: destinationProjectId,
      placement,
    }),
  );
  const accepted = f.transfers.accept('destination', request);
  await prepared;
  f.transfers.commit('source', request);
  await accepted;
  expect(f.source.window).toMatchObject({ projectId: request.projectId });
  expect(f.state.openWindows().find((record) => record.window?.id === 'destination')?.route).toBe(
    `/project/${destinationProjectId}`,
  );
});

it('cancels an asynchronous destination plan before a late reply can prepare it', async () => {
  const f = docking();
  const gate = Promise.withResolvers<{ revision: number; content: typeof request.destination }>();
  f.command.mockImplementation(async (_id, command) =>
    command.kind === 'plan-pane' ? gate.promise : undefined,
  );
  const prepared = expect(f.transfers.prepareDock('source', f.request)).rejects.toThrow(
    'cancelled',
  );
  expect(f.transfers.observe('source', request).status).toBe('prepared');
  const cancelled = f.transfers.cancel('source', request);
  gate.resolve({ revision: 1, content: request.destination });
  await prepared;
  expect((await cancelled).status).toBe('cancelled');
  expect(f.state.pending('move')).toBeNull();
  expect(f.state.read('source', profileId)?.revision).toBe(1);
  expect(f.command.mock.calls.some(([, command]) => command.kind === 'stage-window')).toBe(false);
});

it('rejects incompatible destinations and refuses retirement with a retained dirty draft', async () => {
  const f = docking();
  f.destination.target = 'other@host';
  expect(() => f.transfers.prepareDock('source', f.request)).toThrow('between hosts');
  expect(f.command).not.toHaveBeenCalled();
  f.destination.target = 'local';
  const prepared = f.transfers.prepareDock('source', f.request);
  await vi.waitFor(() => expect(f.state.outcome('move')).toBe('prepared'));
  const accepted = f.transfers.accept('destination', request);
  await prepared;
  f.transfers.commit('source', request);
  await accepted;
  f.state.write('source', profileId, 2, {
    ...request.source,
    buffers: request.destination.buffers,
  });
  expect(() => f.transfers.retire('source', { ...request, revision: 3 })).toThrow(
    'recoverable work',
  );
  expect(f.dismiss).not.toHaveBeenCalled();
});
