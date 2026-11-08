import { expect, it, vi } from 'vitest';
import { HUDDLE_RUNTIME_CAPABILITIES } from '@puddle/shared';
import { gitFixture } from '../../../helpers/huddle/git.js';
import { HuddleGitController } from '../../../../src/runtime/huddle/triggers/git/controller.js';
import * as snapshots from '../../../../src/runtime/huddle/triggers/git/read.js';
it('reports stalled observation and retains capacity until the underlying scan has ended', async () => {
  const f = await gitFixture(),
    release = vi.fn(),
    failed = vi.fn();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const scan = vi.spyOn(snapshots, 'identifyGitRepository').mockImplementationOnce(async () => {
    await pending;
    return {
      repository: f.worktree,
      gitDirectory: f.worktree + '/.git',
      commonDirectory: f.worktree + '/.git',
    };
  });
  vi.useFakeTimers();
  const controller = new HuddleGitController(
    f.ledger,
    f.store,
    HUDDLE_RUNTIME_CAPABILITIES,
    vi.fn(),
    failed,
    vi.fn(),
    { reserve: () => release },
  );
  const started = controller.refresh();
  const rejected = expect(started).rejects.toThrow('15 seconds');
  try {
    await vi.waitFor(() => expect(scan).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(15001);
    await rejected;
    expect(failed).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    finish();
    await controller.settled();
    expect(release).toHaveBeenCalledOnce();
    expect(f.ledger.git.current(0)).toBeNull();
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
  const f = await gitFixture(),
    release = vi.fn(),
    admitted = vi.fn();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const scan = vi.spyOn(snapshots, 'identifyGitRepository').mockImplementationOnce(async () => {
    await pending;
    return {
      repository: f.worktree,
      gitDirectory: f.worktree + '/.git',
      commonDirectory: f.worktree + '/.git',
    };
  });
  const controller = new HuddleGitController(
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
    expect(f.ledger.git.current(0)).toBeNull();
  } finally {
    finish();
    controller.stop();
    await controller.settled();
    scan.mockRestore();
    f.cleanup();
  }
});
