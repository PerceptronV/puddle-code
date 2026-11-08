import { afterEach, expect, it, vi } from 'vitest';
import { HUDDLE_RUNTIME_CAPABILITIES } from '@puddle/shared';
import { gitFixture } from '../../../helpers/huddle/git.js';
import { HuddleGitController } from '../../../../src/runtime/huddle/triggers/git/controller.js';
import { requireHuddleFeatures } from '../../../../src/runtime/huddle/triggers/definitions.js';
import * as reads from '../../../../src/runtime/huddle/triggers/git/read.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Git observation timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture(guard = vi.fn(), linked = false) {
  const f = await gitFixture({ debounceMs: 50, reconcileMs: 1000 }, linked);
  cleanups.push(f.cleanup);
  const admitted = vi.fn(),
    failed = vi.fn(),
    release = vi.fn();
  const controller = new HuddleGitController(
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
it('observes external commits/tags once and disarms across interruption and resume', async () => {
  const f = await fixture();
  await f.controller.refresh();
  expect(f.ledger.page('inbox')).toHaveLength(0);
  await f.command(['commit', '--allow-empty', '-m', 'first']);
  await until(() => f.ledger.page('inbox').length > 0);
  const first = f.ledger.page('inbox').map((row) => JSON.parse(row.body).event);
  expect(
    first
      .flatMap((event) => event.data.changes)
      .map((change) => change.ref)
      .sort(),
  ).toEqual(['HEAD', 'refs/heads/main']);
  await f.command(['tag', 'release']);
  await until(() => f.ledger.page('inbox').length > first.length);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(f.ledger.page('inbox')).toHaveLength(2);
  f.controller.stop();
  f.ledger.activations.setIntent(2, 'interrupted', false);
  await f.controller.settled();
  await f.command(['tag', 'paused']);
  f.ledger.activations.setIntent(3, 'armed', false);
  await f.controller.refresh();
  expect(f.ledger.page('inbox')).toHaveLength(2);
  await f.command(['tag', '-d', 'paused']);
  await until(() => f.ledger.page('inbox').length > 2);
  expect(JSON.parse(f.ledger.page('inbox')[2]!.body).event.data.changes[0]).toMatchObject({
    ref: 'refs/tags/paused',
    newOid: null,
  });
  expect(f.failed).not.toHaveBeenCalled();
});
it('shares common-directory ref reads and gives each explicit source one event', async () => {
  const f = await fixture(vi.fn(), true),
    refs = vi.spyOn(reads, 'readGitRefs');
  await f.controller.refresh();
  expect(refs).toHaveBeenCalledOnce();
  await f.command(['tag', 'shared']);
  await until(() => f.ledger.page('inbox').length >= 2);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const events = f.ledger.page('inbox').map((row) => JSON.parse(row.body).event);
  expect(events).toHaveLength(2);
  expect(events.map((event) => event.source.node).sort()).toEqual(['linked', 'run']);
  expect(
    events.every(
      (event) =>
        event.data.changes.length === 1 && event.data.changes[0].ref === 'refs/tags/shared',
    ),
  ).toBe(true);
  expect(f.failed).not.toHaveBeenCalled();
});
it('reports missing source before admission and rejects old runtimes and exhausted memory', async () => {
  const guard = vi.fn(),
    f = await fixture(guard),
    { git: _, ...old } = HUDDLE_RUNTIME_CAPABILITIES;
  expect(() => requireHuddleFeatures(f.snapshot, old)).toThrow('Git triggers');
  const denied = new HuddleGitController(
    f.ledger,
    f.store,
    HUDDLE_RUNTIME_CAPABILITIES,
    vi.fn(),
    vi.fn(),
    vi.fn(),
    { reserve: () => null },
  );
  await expect(denied.refresh()).rejects.toThrow('host memory capacity');
  expect(f.ledger.git.current(0)).toBeNull();
  await f.controller.refresh();
  guard.mockImplementation(() => {
    throw new Error('definition missing');
  });
  await f.command(['commit', '--allow-empty', '-m', 'first']);
  await until(() => f.failed.mock.calls.length > 0);
  expect(f.failed.mock.calls[0]![0].message).toContain('observation gap: definition missing');
  expect(f.ledger.page('inbox')).toHaveLength(0);
  await f.controller.settled();
  expect(f.release).toHaveBeenCalledOnce();
});
