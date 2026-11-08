import { expect, it, vi } from 'vitest';
import { HUDDLE_RUNTIME_CAPABILITIES } from '@puddle/shared';
import { filetreeFixture } from '../../../helpers/huddle/filetree.js';
import { HuddleFiletreeController } from '../../../../src/runtime/huddle/triggers/filetree/controller.js';
import * as snapshots from '../../../../src/runtime/huddle/triggers/filetree/snapshot.js';
it('reports stalled observation and retains capacity until the underlying scan has ended', async () => {
  const f = filetreeFixture(),
    release = vi.fn(),
    failed = vi.fn();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const scan = vi.spyOn(snapshots, 'scanFiletree').mockImplementationOnce(async () => {
    await pending;
    return { snapshot: [], directories: new Set() };
  });
  vi.useFakeTimers();
  const controller = new HuddleFiletreeController(
    f.ledger,
    f.store,
    HUDDLE_RUNTIME_CAPABILITIES,
    vi.fn(),
    failed,
    vi.fn(),
    { reserve: () => release },
  );
  const started = controller.refresh();
  const rejected = expect(started).rejects.toThrow('10 seconds');
  try {
    await vi.waitFor(() => expect(scan).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(10001);
    await rejected;
    expect(failed).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    finish();
    await controller.settled();
    expect(release).toHaveBeenCalledOnce();
    expect(f.ledger.filetrees.current(0)).toBeNull();
  } finally {
    finish();
    controller.stop();
    await controller.settled();
    scan.mockRestore();
    vi.useRealTimers();
    f.cleanup();
  }
});
it('fences an in-flight scan before admission and retains its allocation until it settles', async () => {
  const f = filetreeFixture(),
    release = vi.fn(),
    admitted = vi.fn();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const scan = vi.spyOn(snapshots, 'scanFiletree').mockImplementationOnce(async () => {
    await pending;
    return { snapshot: [{ path: 'late', signature: '1' }], directories: new Set() };
  });
  const controller = new HuddleFiletreeController(
    f.ledger,
    f.store,
    HUDDLE_RUNTIME_CAPABILITIES,
    admitted,
    vi.fn(),
    vi.fn(),
    { reserve: () => release },
  );
  const started = controller.refresh();
  const rejected = expect(started).rejects.toThrow();
  try {
    await vi.waitFor(() => expect(scan).toHaveBeenCalled());
    controller.stop();
    f.ledger.activations.setIntent(2, 'interrupted', false);
    expect(release).not.toHaveBeenCalled();
    finish();
    await rejected;
    await controller.settled();
    expect(release).toHaveBeenCalledOnce();
    expect(admitted).not.toHaveBeenCalled();
    expect(f.ledger.filetrees.current(0)).toBeNull();
  } finally {
    finish();
    controller.stop();
    await controller.settled();
    scan.mockRestore();
    f.cleanup();
  }
});
