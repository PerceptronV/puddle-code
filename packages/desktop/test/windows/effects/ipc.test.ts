import { expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { registerWindowEffectsIpc } from '../../../src/windows/effects/ipc.js';
import { WindowEffects } from '../../../src/windows/effects/coordination.js';

it('binds claims to the registered sender and rejects renderer-selected hosts and oversized input', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
  } as unknown as Pick<IpcMain, 'handle'>;
  const context = vi.fn(() => ({
    identity: { id: 'host', kind: 'host' as const },
    hostId: 'trusted-host',
  }));
  const effects = new WindowEffects(
    () => [{ id: 'host', host: 'local', kind: 'host', focused: false }],
    vi.fn(),
  );
  registerWindowEffectsIpc(ipc, context, effects);
  const claim = handlers.get('puddle:window-notification-claim')!;
  expect(() => claim({}, { id: 'event', host: 'another' })).toThrow();
  expect(() => claim({}, { id: 'x'.repeat(3000) })).toThrow('too large');
  expect(claim({}, { id: 'event' })).toBe(true);
  expect(claim({}, { id: 'event' })).toBe(false);
  context.mockImplementation(() => {
    throw new Error('Invalid window sender');
  });
  expect(() => handlers.get('puddle:window-effects-status')!({})).toThrow('Invalid window sender');
  expect(() => claim({}, { id: 'next' })).toThrow('Invalid window sender');
});
