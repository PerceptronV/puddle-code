import { expect, it, vi } from 'vitest';
import type { DesktopWindowCommand, DesktopWindowLifecycleBridge } from '@puddle/shared';
import { registerRendererLifecycle } from '../../src/features/windows/renderer-lifecycle';

it('fences interaction until every checkpoint finishes, then explicitly resumes on cancellation', async () => {
  let receive!: (command: DesktopWindowCommand) => void;
  const bridge: DesktopWindowLifecycleBridge = {
    onCommand: (callback) => {
      receive = callback;
      return vi.fn();
    },
    ready: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
  };
  const pending = Promise.withResolvers<void>();
  const source = { checkpoint: vi.fn(() => pending.promise), resume: vi.fn() };
  const fence = vi.fn();
  await registerRendererLifecycle(bridge, () => [source], fence, vi.fn());
  receive({ id: 'close', kind: 'checkpoint' });
  await Promise.resolve();
  expect(fence).toHaveBeenCalledWith(true);
  expect(bridge.reply).not.toHaveBeenCalled();
  pending.resolve();
  await vi.waitFor(() => expect(bridge.reply).toHaveBeenCalledWith({ id: 'close' }));
  expect(fence).not.toHaveBeenCalledWith(false);
  receive({ id: 'cancel', kind: 'resume' });
  await vi.waitFor(() => expect(source.resume).toHaveBeenCalledOnce());
  expect(fence).toHaveBeenLastCalledWith(false);
});

it('reports a failed checkpoint only after other profiles finish saving', async () => {
  let receive!: (command: DesktopWindowCommand) => void;
  const bridge: DesktopWindowLifecycleBridge = {
    onCommand: (callback) => {
      receive = callback;
      return vi.fn();
    },
    ready: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
  };
  const pending = Promise.withResolvers<void>();
  const sources = [
    {
      checkpoint: vi.fn(async () => {
        throw new Error('Disk is full');
      }),
      resume: vi.fn(),
    },
    { checkpoint: vi.fn(() => pending.promise), resume: vi.fn() },
  ];
  await registerRendererLifecycle(bridge, () => sources, vi.fn(), vi.fn());
  receive({ id: 'close', kind: 'checkpoint' });
  await Promise.resolve();
  expect(bridge.reply).not.toHaveBeenCalled();
  pending.resolve();
  await vi.waitFor(() =>
    expect(bridge.reply).toHaveBeenCalledWith({ id: 'close', error: 'Disk is full' }),
  );
});
