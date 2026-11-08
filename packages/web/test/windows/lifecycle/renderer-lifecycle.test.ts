import { expect, it, vi } from 'vitest';
import type { DesktopWindowCommand, DesktopWindowLifecycleBridge } from '@puddle/shared';
import { registerRendererLifecycle } from '../../../src/features/windows/lifecycle/renderer-lifecycle';
import { registerPaneClose } from '../../../src/features/windows/lifecycle/pane-close';
import { CloseReview } from '../../../src/features/workspace/tabs/close/close-review';

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

it('acknowledges a source-directed pane move without waiting for source retirement', async () => {
  let receive!: (command: DesktopWindowCommand) => void;
  const bridge: DesktopWindowLifecycleBridge = {
    onCommand: (callback) => {
      receive = callback;
      return vi.fn();
    },
    ready: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
  };
  const move = vi.fn();
  await registerRendererLifecycle(bridge, () => [], vi.fn(), vi.fn(), undefined, undefined, move);
  const command = {
    id: 'drop',
    kind: 'move-pane' as const,
    profileId: '1234567890',
    projectId: 'abcdef1234',
    paneId: 'source-pane',
    destinationId: 'destination',
    destinationProjectId: '0000000001',
    placement: { paneId: 'destination-pane', edge: 'bottom' as const },
  };
  receive(command);
  await vi.waitFor(() => expect(bridge.reply).toHaveBeenCalledWith({ id: 'drop' }));
  expect(move).toHaveBeenCalledExactlyOnceWith(command);
});
it('acknowledges human review immediately and allows quit to cancel it before checkpoint', async () => {
  let receive!: (command: DesktopWindowCommand) => void;
  const bridge: DesktopWindowLifecycleBridge = {
    onCommand: (callback) => {
      receive = callback;
      return vi.fn();
    },
    ready: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
  };
  const review = new CloseReview<null>();
  const accepted = vi.fn();
  const unregister = registerPaneClose(async (signal) => {
    if (await review.request('draft', null, signal)) accepted();
  });
  const checkpoint = vi.fn(async () => {
    expect(review.get()).toBeNull();
  });
  try {
    await registerRendererLifecycle(
      bridge,
      () => [{ checkpoint, resume: vi.fn() }],
      vi.fn(),
      vi.fn(),
    );
    receive({ id: 'review', kind: 'review-close' });
    await vi.waitFor(() => expect(bridge.reply).toHaveBeenCalledWith({ id: 'review' }));
    expect(review.get()).not.toBeNull();
    receive({ id: 'quit', kind: 'checkpoint' });
    await vi.waitFor(() => expect(bridge.reply).toHaveBeenCalledWith({ id: 'quit' }));
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(accepted).not.toHaveBeenCalled();
  } finally {
    unregister();
  }
});
