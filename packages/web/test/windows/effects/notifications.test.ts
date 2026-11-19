import { afterEach, expect, it, vi } from 'vitest';
import { claimWindowNotification } from '../../../src/features/windows/effects/notifications';

afterEach(() => vi.unstubAllGlobals());
it('never falls back to local delivery after a denied or uncertain native claim', async () => {
  const claim = vi.fn().mockResolvedValue(false);
  vi.stubGlobal('window', {
    puddleDesktop: { windows: { effects: { claimNotification: claim } } },
  });
  expect(await claimWindowNotification('one', false, '0123456789')).toBe(false);
  claim.mockRejectedValue(new Error('lost reply'));
  expect(await claimWindowNotification('two', false, '0123456789')).toBe(false);
  expect(claim).toHaveBeenCalledTimes(2);
});

it('retains browser delivery and forwards the legacy claim marker only for status events', async () => {
  vi.stubGlobal('window', {});
  expect(await claimWindowNotification('one', false, '0123456789')).toBe(true);
  const claim = vi.fn().mockResolvedValue(true);
  vi.stubGlobal('window', {
    puddleDesktop: { windows: { effects: { claimNotification: claim } } },
  });
  expect(await claimWindowNotification('two', true, '0123456789')).toBe(true);
  expect(claim).toHaveBeenCalledWith({ id: 'two', legacy: true });
});

it('sends a profile only to shells advertising profile-scoped notification claims', async () => {
  const claim = vi.fn().mockResolvedValue(true);
  vi.stubGlobal('window', {
    puddleDesktop: {
      windows: { effects: { claimNotification: claim, setNotificationProfile: vi.fn() } },
    },
  });
  expect(await claimWindowNotification('event', false, '0123456789')).toBe(true);
  expect(claim).toHaveBeenCalledWith({ id: 'event', profileId: '0123456789' });
});
