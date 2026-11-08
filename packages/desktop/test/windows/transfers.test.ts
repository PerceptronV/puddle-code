import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { uiStateSnapshotSchema, type DesktopPaneDetach } from '@puddle/shared';
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
