import { expect, it, vi } from 'vitest';
import type { DesktopPaneDrop, DesktopWindowContext } from '@puddle/shared';
import { WindowDrags } from '../../src/windows/drags.js';

const profileId = '1234567890';
const projectId = 'abcdef1234';
const offer = { token: 'offer', profileId, projectId, paneId: 'pane' };
const drop: DesktopPaneDrop = {
  token: offer.token,
  sourceId: 'source',
  profileId,
  projectId: '0000000001',
  placement: { paneId: 'destination-pane', edge: 'bottom' },
};
function setup() {
  const windows = new Map<string, DesktopWindowContext>([
    ['source', { hostId: 'host', identity: { id: 'source', kind: 'pane', profileId, projectId } }],
    ['destination', { hostId: 'host', identity: { id: 'destination', kind: 'host' } }],
  ]);
  const move = vi.fn(async () => undefined);
  let now = 1;
  const drags = new WindowDrags({
    context: (id) => {
      const context = windows.get(id);
      if (!context) throw new Error('Window unavailable');
      return context;
    },
    move,
    now: () => now,
  });
  return { drags, windows, move, advance: () => (now += 60_000) };
}

it('dispatches the source pane once with the visible destination project and placement', async () => {
  const { drags, move } = setup();
  drags.beginPane('source', offer);
  await drags.dropPane('destination', drop);
  expect(move).toHaveBeenCalledExactlyOnceWith('source', {
    kind: 'move-pane',
    profileId,
    projectId,
    paneId: 'pane',
    destinationId: 'destination',
    destinationProjectId: drop.projectId,
    placement: drop.placement,
  });
  await expect(drags.dropPane('destination', drop)).rejects.toThrow('drag has ended');
});

it('accepts a host file offer into a fixed pane and rejects a different drag kind', async () => {
  const { drags, windows, move } = setup();
  windows.get('source')!.identity = { kind: 'host', id: 'source' };
  windows.get('destination')!.identity = {
    kind: 'pane',
    id: 'destination',
    profileId,
    projectId: drop.projectId,
  };
  const ref = {
    type: 'editor' as const,
    tab: { session: '00000000-0000-4000-8000-000000000001', path: 'draft.ts' },
  };
  drags.beginTab('source', { token: offer.token, profileId, projectId, ref });
  await expect(drags.dropPane('destination', drop)).rejects.toThrow('drag has ended');
  await drags.dropTab('destination', { ...drop, placement: { paneId: 'target', edge: 'center' } });
  expect(move).toHaveBeenCalledExactlyOnceWith('source', {
    kind: 'move-tab',
    profileId,
    projectId,
    ref,
    paneId: undefined,
    destinationId: 'destination',
    destinationProjectId: drop.projectId,
    placement: { paneId: 'target', edge: 'center' },
  });
  await expect(drags.dropTab('destination', drop)).rejects.toThrow('drag has ended');
});

it('consumes dispatch even when the source acknowledgement is lost', async () => {
  const { drags, move } = setup();
  move.mockRejectedValue(new Error('Disconnected'));
  drags.beginPane('source', offer);
  await expect(drags.dropPane('destination', drop)).rejects.toThrow('Disconnected');
  await expect(drags.dropPane('destination', drop)).rejects.toThrow('drag has ended');
  expect(move).toHaveBeenCalledOnce();
});

it('expires offers and invalidates them on a new drag or renderer replacement', async () => {
  const { drags, advance, move } = setup();
  drags.beginPane('source', offer);
  advance();
  await expect(drags.dropPane('destination', drop)).rejects.toThrow('drag has ended');
  drags.beginPane('source', offer);
  drags.beginPane('source', { ...offer, token: 'replacement' });
  await expect(drags.dropPane('destination', drop)).rejects.toThrow('drag has ended');
  drags.disconnected('source');
  await expect(drags.dropPane('destination', { ...drop, token: 'replacement' })).rejects.toThrow(
    'drag has ended',
  );
  expect(move).not.toHaveBeenCalled();
});

it('rejects unregistered, foreign-host and foreign-profile drops before dispatch', async () => {
  const { drags, windows, move } = setup();
  await expect(drags.dropPane('destination', drop)).rejects.toThrow('drag has ended');
  drags.beginPane('source', offer);
  await expect(drags.dropPane('destination', { ...drop, token: 'forged' })).rejects.toThrow(
    'ended',
  );
  windows.get('destination')!.hostId = 'other-host';
  await expect(drags.dropPane('destination', drop)).rejects.toThrow('between hosts');
  windows.get('destination')!.hostId = 'host';
  await expect(drags.dropPane('destination', { ...drop, profileId: '0000000000' })).rejects.toThrow(
    'between profiles',
  );
  expect(move).not.toHaveBeenCalled();
});

it('rechecks both live presentations and validates fixed project identity', async () => {
  const { drags, windows, move } = setup();
  expect(() => drags.beginPane('destination', offer)).toThrow('cannot offer');
  expect(() => drags.beginPane('source', { ...offer, projectId: '0000000000' })).toThrow(
    'cannot offer',
  );
  drags.beginPane('source', offer);
  windows.get('destination')!.identity = {
    id: 'destination',
    kind: 'project',
    profileId,
    projectId,
  };
  await expect(drags.dropPane('destination', drop)).rejects.toThrow('project presentations');
  windows.get('source')!.stagingTransfer = 'pending';
  await expect(drags.dropPane('destination', { ...drop, projectId })).rejects.toThrow('available');
  windows.delete('source');
  await expect(drags.dropPane('destination', { ...drop, projectId })).rejects.toThrow(
    'unavailable',
  );
  expect(move).not.toHaveBeenCalled();
});
