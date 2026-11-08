import { expect, it, vi } from 'vitest';
import { WindowEffects, type EffectWindow } from '../../../src/windows/effects/coordination.js';

const host: EffectWindow = { id: 'host', host: 'local', kind: 'host', focused: false };
const pane: EffectWindow = { id: 'pane', host: 'local', kind: 'pane', focused: true };

it('elects one automatic offer owner and hands over when the host renderer disappears', () => {
  let live = [pane, host];
  const send = vi.fn();
  const effects = new WindowEffects(() => live, send);
  effects.publish();
  expect(effects.status('host')).toEqual({ hostOffers: true, desktopOffers: true });
  expect(effects.status('pane')).toEqual({ hostOffers: false, desktopOffers: false });
  send.mockClear();
  effects.publish();
  expect(send).not.toHaveBeenCalled();
  live = [pane];
  effects.publish();
  expect(send).toHaveBeenCalledWith('pane', { hostOffers: true, desktopOffers: true });
  live = [pane, host];
  effects.publish();
  expect(send).toHaveBeenCalledWith('pane', { hostOffers: false, desktopOffers: false });
  expect(send).toHaveBeenCalledWith('host', { hostOffers: true, desktopOffers: true });
});

it('elects the focused renderer for policy and consumes a notification across focus changes', () => {
  let live = [host, pane];
  const effects = new WindowEffects(() => live, vi.fn());
  expect(effects.claimNotification('host', { id: 'event' })).toBe(false);
  expect(effects.claimNotification('pane', { id: 'event' })).toBe(true);
  live = [
    { ...host, focused: true },
    { ...pane, focused: false },
  ];
  expect(effects.claimNotification('host', { id: 'event' })).toBe(false);
  expect(effects.claimNotification('host', { id: 'next-event' })).toBe(true);
});

it('isolates hosts and falls back to a detached owner without any host window', () => {
  const remote = { ...host, id: 'remote-host', host: 'ssh.example' };
  const effects = new WindowEffects(() => [{ ...pane, focused: false }, remote], vi.fn());
  expect(effects.status('pane')).toEqual({ hostOffers: true, desktopOffers: false });
  expect(effects.status('remote-host')).toEqual({ hostOffers: true, desktopOffers: true });
  expect(effects.claimNotification('pane', { id: 'event' })).toBe(true);
  expect(effects.claimNotification('remote-host', { id: 'event' })).toBe(true);
  expect(effects.claimNotification('unknown', { id: 'event' })).toBe(false);
});

it('bounds claim history and permits later legacy attention transitions', () => {
  let now = 0;
  const effects = new WindowEffects(
    () => [host],
    vi.fn(),
    () => now,
  );
  expect(effects.claimNotification('host', { id: 'old', legacy: true })).toBe(true);
  expect(effects.claimNotification('host', { id: 'old', legacy: true })).toBe(false);
  now = 2001;
  expect(effects.claimNotification('host', { id: 'old', legacy: true })).toBe(true);
  for (let i = 0; i < 2048; i++) effects.claimNotification('host', { id: `event-${i}` });
  expect(effects.claimNotification('host', { id: 'old', legacy: true })).toBe(true);
  expect(effects.claimNotification('host', { id: 'event-2047' })).toBe(false);
});
