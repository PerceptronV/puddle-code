import { expect, it, vi } from 'vitest';
import { uiStateSnapshotSchema, type DesktopTransferObservation } from '@puddle/shared';
import { acceptDestination } from '../../../src/features/windows/transfers/accept-destination';

const reference = { id: 'move', profileId: '1234567890' };
const version = {
  revision: 2,
  content: { snapshot: uiStateSnapshotSchema.parse({}), buffers: [], views: {} },
};
const lost = new Error('Acceptance reply lost');

it('uses the normal acceptance result without an extra observation', async () => {
  const bridge = { accept: vi.fn().mockResolvedValue(version), observe: vi.fn() };
  expect(await acceptDestination(bridge, reference)).toEqual(version);
  expect(bridge.accept).toHaveBeenCalledExactlyOnceWith(reference);
  expect(bridge.observe).not.toHaveBeenCalled();
});

it('recovers a committed destination after a lost reply without repeating acceptance', async () => {
  const bridge = {
    accept: vi.fn().mockRejectedValue(lost),
    observe: vi.fn().mockResolvedValue({ status: 'committed', version }),
  };
  expect(await acceptDestination(bridge, reference)).toEqual(version);
  expect(bridge.accept).toHaveBeenCalledExactlyOnceWith(reference);
  expect(bridge.observe).toHaveBeenCalledExactlyOnceWith(reference);
});

it.each<DesktopTransferObservation>([
  { status: 'prepared', version },
  { status: 'cancelled', version },
  { status: 'unknown', version },
  { status: 'committed', version: null },
])('does not treat $status without a committed revision as acceptance', async (observed) => {
  const bridge = {
    accept: vi.fn().mockRejectedValue(lost),
    observe: vi.fn().mockResolvedValue(observed),
  };
  await expect(acceptDestination(bridge, reference)).rejects.toBe(lost);
  expect(bridge.accept).toHaveBeenCalledOnce();
  expect(bridge.observe).toHaveBeenCalledOnce();
});

it('retains uncertain failure when observation is unavailable', async () => {
  const bridge = {
    accept: vi.fn().mockRejectedValue(lost),
    observe: vi.fn().mockRejectedValue(new Error('Disconnected')),
  };
  await expect(acceptDestination(bridge, reference)).rejects.toBe(lost);
  expect(bridge.accept).toHaveBeenCalledOnce();
  expect(bridge.observe).toHaveBeenCalledOnce();
});
