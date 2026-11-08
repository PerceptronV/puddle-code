import { EventEmitter } from 'node:events';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { HUDDLE_RUNTIME_CAPABILITIES } from '@puddle/shared';
import { filetreeFixture } from '../../../helpers/huddle/filetree.js';
import { HuddleFiletreeController } from '../../../../src/runtime/huddle/triggers/filetree/controller.js';

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  // Simulate an OS watcher silently missing every notification.
  watch: () => Object.assign(new EventEmitter(), { close() {} }),
}));
it('reconciles missed notifications as net changes without inventing intervening edits', async () => {
  const f = filetreeFixture({ reconcileMs: 1000 }),
    failed = vi.fn();
  const controller = new HuddleFiletreeController(
    f.ledger,
    f.store,
    HUDDLE_RUNTIME_CAPABILITIES,
    vi.fn(),
    failed,
    vi.fn(),
  );
  try {
    await controller.refresh();
    writeFileSync(join(f.worktree, 'transient'), 'not an observed edit');
    unlinkSync(join(f.worktree, 'transient'));
    writeFileSync(join(f.worktree, 'retained'), 'one');
    writeFileSync(join(f.worktree, 'retained'), 'two');
    await vi.waitFor(() => expect(f.ledger.page('inbox')).toHaveLength(1), { timeout: 3000 });
    const event = JSON.parse(f.ledger.page('inbox')[0]!.body).event;
    expect(event.data).toMatchObject({
      reconciled: true,
      changes: [{ path: 'retained', kind: 'create' }],
      batch: 1,
      final: true,
    });
    expect(failed).not.toHaveBeenCalled();
  } finally {
    controller.stop();
    await controller.settled();
    f.cleanup();
  }
});
