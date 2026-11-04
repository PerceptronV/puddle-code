import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startDaemon } from '../../../src/daemon.js';
import { readRuntime } from '../../../src/runtime-file.js';

it('closes client admission immediately and retains SQLite until admitted work finishes', async () => {
  // No accounts, providers or terminals: only this temporary daemon owns a socket.
  const home = await mkdtemp(join(tmpdir(), 'puddle-shutdown-'));
  const daemon = await startDaemon({ home, adapters: [], port: 0 });
  let finish!: () => void;
  const request = daemon.admission.run(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const drain = vi.spyOn(daemon.admission, 'drain');
  let stopping: Promise<void> | undefined;
  try {
    stopping = daemon.stop();
    expect(daemon.stop()).toBe(stopping);
    expect(() => daemon.admission.enter()).toThrow(/maintenance/);
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    expect(readRuntime(daemon.paths)).toMatchObject({ port: daemon.port });
    // A missing row still reaches the live store and returns the domain error.
    expect(() => daemon.service.get('absent')).toThrow(/does not exist/);
    finish();
    await request;
    await stopping;
    expect(readRuntime(daemon.paths)).toBeNull();
    expect(() => daemon.service.get('absent')).toThrow(/database connection is not open/);
    expect(daemon.stop()).toBe(stopping);
  } finally {
    finish();
    await request;
    await (stopping ?? daemon.stop());
    await rm(home, { recursive: true, force: true });
  }
});
