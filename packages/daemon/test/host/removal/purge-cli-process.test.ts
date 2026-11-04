import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hostPurgeRecordSchema, PROTOCOL_VERSION } from '@puddle/shared';
import { atomicPrivateJson, readPrivateJson } from '@puddle/shared/node';
import { readHostBootIdentity, requireNoHostRemoval } from '@puddle/shared/node/host-control';
import { removalCliFixture } from '../../helpers/removal-cli.js';
import { startHostControl } from '../../../src/security/control.js';
import { LeaseRegistry } from '../../../src/security/leases.js';

it('runs built-CLI purge batches and fresh reinstall after a fixture-only simulated boot change', async () => {
  const f = await removalCliFixture({ nativeBootIdentity: true });
  const registry = new LeaseRegistry();
  let close: (() => Promise<void>) | undefined;
  let pendingInstall: Promise<unknown> | undefined;
  try {
    const data = join(f.home, 'profiles/fixture-data');
    mkdirSync(data, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 1100; index++)
      writeFileSync(join(data, String(index)), 'isolated purge fixture');
    const lock = join(f.home, 'bin/.install-lock');
    const lockInode = statSync(lock).ino;
    const claims = join(f.home, 'runtime-claims');
    const claimInodes = new Map(
      readdirSync(claims).map((name) => [name, statSync(join(claims, name)).ino]),
    );
    const helper = join(f.release, 'daemon/host-update.mjs');
    const helperInode = statSync(helper).ino;
    const args = ['remove', 'daemon', '--yes', '--purge', '--stop-runtimes'];
    const waiting = await f.invoke(...args);
    expect(waiting.stdout + waiting.stderr).toContain('Reboot the target machine');
    expect(existsSync(join(f.home, 'puddle.db'))).toBe(true);
    expect(existsSync(join(data, '1099'))).toBe(true);
    expect(existsSync(f.file)).toBe(false);
    expect(() => requireNoHostRemoval(f.home)).toThrow('removal');
    const record = join(f.home, 'installation/removal/purge.json');
    const barrier = hostPurgeRecordSchema.parse(readPrivateJson(record));
    expect(barrier.phase).toBe('waiting');
    expect(barrier.boot_id).toBe(await readHostBootIdentity());

    // This exercises real helper/CLI orchestration, NOT real reboot acceptance.
    // Only this private fixture journal is changed: the helper still reads the
    // current OS kernel UUID and every supervisor/process belongs to the fixture.
    atomicPrivateJson(record, { ...barrier, boot_id: randomUUID() }, { syncDirectory: true });
    const completed = await f.invoke(...args);
    expect(completed.stdout + completed.stderr).toContain('Managed user data purged');
    const commands = readFileSync(f.commandLog, 'utf8').split('\n');
    expect(
      commands.filter((command) => command.includes(' --apply-purge ')).length,
    ).toBeGreaterThanOrEqual(3);
    expect(existsSync(join(f.home, 'profiles'))).toBe(false);
    expect(existsSync(join(f.home, 'puddle.db'))).toBe(false);
    for (const path of f.profiles) expect(existsSync(path)).toBe(false);
    expect(existsSync(record)).toBe(false);
    expect(
      hostPurgeRecordSchema.parse(readPrivateJson(join(f.home, 'installation/removal/purged.json')))
        .phase,
    ).toBe('complete');
    expect(() => requireNoHostRemoval(f.home)).not.toThrow();
    expect(statSync(lock).ino).toBe(lockInode);
    expect(statSync(helper).ino).toBe(helperInode);
    for (const [name, inode] of claimInodes) expect(statSync(join(claims, name)).ino).toBe(inode);
    expect(existsSync(join(f.home, 'runtime-controller.json'))).toBe(true);

    const installing = f.invoke('install', 'daemon');
    pendingInstall = installing;
    let installOutcome = 'pending';
    void installing.then(
      (result) => {
        installOutcome = result.stdout + result.stderr;
      },
      (error: unknown) => {
        installOutcome = String(error);
      },
    );
    // A fresh installation must recreate service configuration and actually
    // dispatch startup; the retained VERSION must not produce "already installed".
    await expect
      .poll(() => ({ started: existsSync(join(f.home, 'starts')), outcome: installOutcome }), {
        timeout: 10_000,
      })
      .toMatchObject({ started: true });
    expect(existsSync(f.file)).toBe(true);
    close = await startHostControl(f.home, registry, () => ({
      port: 7434,
      version: { version: '0.4.0', protocol: PROTOCOL_VERSION },
    }));
    const installed = await installing;
    expect(installed.stdout + installed.stderr).toContain('v0.4.0 is ready');
    expect(readFileSync(join(f.home, 'supervisor'), 'utf8').trim()).toBe('systemd');
    // SQLite initialisation belongs to real daemon startup; the scripted service
    // and readiness endpoint cannot establish that separate acceptance property.
    expect(existsSync(data)).toBe(false);
    for (const path of f.profiles) expect(existsSync(path)).toBe(false);
    await f.invoke('install', 'daemon');
    expect(readFileSync(join(f.home, 'starts'), 'utf8')).toBe('start\n');
  } finally {
    await pendingInstall?.catch(() => {});
    await close?.();
    registry.dispose();
    f.close();
  }
});
