import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HUDDLE_RUNTIME_CAPABILITIES } from '@puddle/shared';
import { filetreeFixture } from '../../../helpers/huddle/filetree.js';
import { HuddleFiletreeController } from '../../../../src/runtime/huddle/triggers/filetree/controller.js';
import { requireHuddleFeatures } from '../../../../src/runtime/huddle/triggers/definitions.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Filetree observation timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function fixture(guard = vi.fn()) {
  const f = filetreeFixture({ debounceMs: 50, reconcileMs: 1000 });
  cleanups.push(f.cleanup);
  const admitted = vi.fn(),
    failed = vi.fn(),
    release = vi.fn();
  const controller = new HuddleFiletreeController(
    f.ledger,
    f.store,
    HUDDLE_RUNTIME_CAPABILITIES,
    admitted,
    failed,
    guard,
    { reserve: () => release },
  );
  cleanups.push(async () => {
    controller.stop();
    await controller.settled();
  });
  return { ...f, controller, admitted, failed, release };
}
it('observes external writes and new directories, coalesces saves, and stops all admission on interrupt', async () => {
  const f = fixture();
  writeFileSync(join(f.worktree, 'existing'), 'before');
  await f.controller.refresh();
  expect(f.ledger.page('inbox')).toHaveLength(0);
  writeFileSync(join(f.worktree, 'temp'), 'after');
  renameSync(join(f.worktree, 'temp'), join(f.worktree, 'existing'));
  mkdirSync(join(f.worktree, 'nested'));
  writeFileSync(join(f.worktree, 'nested/new'), 'x');
  await until(() => f.ledger.page('inbox').length > 0);
  const changes = f.ledger.page('inbox').flatMap((row) => JSON.parse(row.body).event.data.changes);
  expect(changes).toContainEqual({ path: 'existing', kind: 'change' });
  expect(changes).toContainEqual({ path: 'nested/new', kind: 'create' });
  expect(changes.some((change: { path: string }) => change.path === 'temp')).toBe(false);
  f.controller.stop();
  f.ledger.activations.setIntent(2, 'interrupted', false);
  await f.controller.settled();
  const count = f.ledger.page('inbox').length;
  writeFileSync(join(f.worktree, 'existing'), 'stopped');
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.ledger.page('inbox')).toHaveLength(count);
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.failed).not.toHaveBeenCalled();
});
it('reports missing source as a gap before admitting changes', async () => {
  const guard = vi.fn();
  const f = fixture(guard);
  await f.controller.refresh();
  guard.mockImplementation(() => {
    throw new Error('definition missing');
  });
  writeFileSync(join(f.worktree, 'new'), 'x');
  await until(() => f.failed.mock.calls.length > 0);
  expect(f.failed.mock.calls[0]![0].message).toContain('observation gap: definition missing');
  expect(f.ledger.page('inbox')).toHaveLength(0);
  await f.controller.settled();
  expect(f.release).toHaveBeenCalledOnce();
});
it('refuses unsupported runtimes and memory exhaustion before retaining baseline state', async () => {
  const f = fixture(),
    { filetree: _, ...old } = HUDDLE_RUNTIME_CAPABILITIES;
  expect(() => requireHuddleFeatures(f.snapshot, old)).toThrow('Filetree triggers');
  const controller = new HuddleFiletreeController(
    f.ledger,
    f.store,
    HUDDLE_RUNTIME_CAPABILITIES,
    vi.fn(),
    vi.fn(),
    vi.fn(),
    { reserve: () => null },
  );
  await expect(controller.refresh()).rejects.toThrow('host memory capacity');
  expect(f.ledger.filetrees.current(0)).toBeNull();
});
