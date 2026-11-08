import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { HUDDLE_RUNTIME_CAPABILITIES } from '@puddle/shared';
import { gitFixture } from '../../../helpers/huddle/git.js';
import { HuddleGitController } from '../../../../src/runtime/huddle/triggers/git/controller.js';

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  watch: () => Object.assign(new EventEmitter(), { close() {} }),
}));
it('reconciles silent notification loss without inventing transient ref events', async () => {
  const f = await gitFixture({ reconcileMs: 1000 }),
    failed = vi.fn();
  await f.command(['commit', '--allow-empty', '-m', 'baseline']);
  const controller = new HuddleGitController(
    f.ledger,
    f.store,
    HUDDLE_RUNTIME_CAPABILITIES,
    vi.fn(),
    failed,
    vi.fn(),
  );
  try {
    await controller.refresh();
    await f.command(['tag', 'transient']);
    await f.command(['tag', '-d', 'transient']);
    await f.command(['tag', 'retained']);
    await f.command(['pack-refs', '--all', '--prune']);
    await vi.waitFor(() => expect(f.ledger.page('inbox')).toHaveLength(1), { timeout: 3000 });
    const event = JSON.parse(f.ledger.page('inbox')[0]!.body).event;
    expect(event.data).toMatchObject({
      reconciled: true,
      changes: [{ ref: 'refs/tags/retained', oldOid: null }],
      batch: 1,
      final: true,
    });
    expect(event.data.changes).toHaveLength(1);
    expect(failed).not.toHaveBeenCalled();
  } finally {
    controller.stop();
    await controller.settled();
    f.cleanup();
  }
});
