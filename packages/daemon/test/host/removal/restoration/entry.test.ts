import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { scriptedRemovalSupervisor } from '../../../helpers/removal-supervisor.js';
import { buildHostUpdateEntry } from '../../../helpers/host-update-entry.js';
import { removalInstallationFixture } from '../../../helpers/removal-service.js';
import { HostRemovalServiceOperation } from '../../../../src/host/removal/operations/services.js';

it('runs pinned removal inspection, explicit restoration and ordinary startup through the built entry', async () => {
  const f = removalInstallationFixture('systemd');
  try {
    const operation = await HostRemovalServiceOperation.prepare(
      f.guard,
      [await f.review()],
      f.options,
    );
    const id = operation.read().id;
    await operation.stop('daemon');
    const controller = f.guard.acquireController();
    try {
      await operation.unregister('daemon');
    } finally {
      controller.release();
    }
    f.guard.release();
    const { node, entry } = await buildHostUpdateEntry(f.release);
    writeFileSync(join(f.home, 'supervisor'), 'systemd', { mode: 0o600 });
    const env = scriptedRemovalSupervisor(f.home, node);
    const invoke = (...args: string[]) =>
      promisify(execFile)(node, [entry, '--home', f.home, ...args], { env, timeout: 15_000 });
    expect(JSON.parse((await invoke('--inspect-removal')).stdout)).toEqual({
      state: 'removed',
      id,
    });
    const rejected = {
      code: 1,
      stdout: '',
      stderr: 'The recorded host removal could not be inspected or restored\n',
    };
    await expect(invoke('--restore-services', randomUUID())).rejects.toMatchObject(rejected);
    await expect(invoke('--restore-services', id, '--resume')).rejects.toMatchObject(rejected);
    expect(existsSync(f.file)).toBe(false);
    await invoke('--restore-services', id);
    expect(readFileSync(f.file, 'utf8')).toBe('reviewed definition');
    expect(existsSync(join(f.home, 'starts'))).toBe(false);
    expect(JSON.parse((await invoke('--inspect-removal')).stdout)).toEqual({
      state: 'restored',
      id,
    });
    await expect(invoke('--restore-services', id)).rejects.toMatchObject(rejected);
    await invoke('--start-daemon');
    expect(readFileSync(join(f.home, 'starts'), 'utf8')).toBe('start\n');
    expect(existsSync(join(f.home, 'puddle.db'))).toBe(false);
  } finally {
    f.close();
  }
});
