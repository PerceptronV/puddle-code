import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  uiStateSnapshotSchema,
  type DesktopPaneDetach,
  type DesktopWindowTransferCommand,
} from '@puddle/shared';
import type { ReopenWindow } from '../../src/reopen.js';
import { DesktopWindowState } from '../../src/windows/state.js';
import { WindowTransfers } from '../../src/windows/transfers.js';

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

it('rolls back a destination launch failure without removing source drafts', async () => {
  const { state, transfers, open, dismiss } = setup();
  open.mockRejectedValue(new Error('Window creation failed'));
  await expect(transfers.preparePane('source', request)).rejects.toThrow('creation failed');
  expect(state.outcome(request.id)).toBe('cancelled');
  expect(state.openWindows()).toHaveLength(1);
  expect(state.read('source', profileId)?.content.buffers).toEqual(request.destination.buffers);
  expect(dismiss).toHaveBeenCalledOnce();
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

function docking() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-docking-'));
  homes.push(home);
  const state = new DesktopWindowState(join(home, 'state.json'));
  const source: ReopenWindow = {
    target: 'local',
    window: { kind: 'pane', id: 'source', profileId, projectId: request.projectId },
  };
  const destination: ReopenWindow = {
    target: 'local',
    window: { kind: 'host', id: 'destination' },
    route: '/project/0000000001',
  };
  state.syncOpenWindows([source, destination]);
  state.write('source', profileId, 0, request.destination);
  state.write('destination', profileId, 0, request.source);
  const command = vi.fn(async (_id: string, command: DesktopWindowTransferCommand) =>
    command.kind === 'plan-pane' ? { revision: 1, content: request.destination } : undefined,
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
