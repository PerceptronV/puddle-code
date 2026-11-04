import { existsSync, readFileSync, readdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { requireNoHostRemoval } from '@puddle/shared/node/host-control';
import { HostRemovalServiceOperation } from '../../../../src/host/removal/operations/services.js';
import { HostRemovalServiceRestore } from '../../../../src/host/removal/restoration/services.js';
import { restoreServiceDefinition } from '../../../../src/host/removal/restoration/definition.js';
import { removalInstallationFixture as fixture } from '../../../helpers/removal-service.js';

async function removed(kind: 'launchd' | 'systemd' = 'launchd') {
  const f = fixture(kind);
  try {
    const operation = await HostRemovalServiceOperation.prepare(
      f.guard,
      [await f.review()],
      f.options,
    );
    await operation.stop('daemon');
    const controller = f.guard.acquireController();
    try {
      await operation.unregister('daemon');
    } catch (error) {
      controller.release();
      throw error;
    }
    return {
      ...f,
      operation,
      controller,
      close: () => {
        controller.release();
        f.close();
      },
    };
  } catch (error) {
    f.close();
    throw error;
  }
}

it.each(['launchd', 'systemd'] as const)(
  'restores the exact %s definition before handing off to ordinary startup',
  async (kind) => {
    const f = await removed(kind);
    try {
      const original = f.operation.read();
      const restore = new HostRemovalServiceRestore(f.guard, f.operation, f.options);
      await expect(restore.handoff()).rejects.toThrow('incomplete');
      expect(() => requireNoHostRemoval(f.home)).toThrow();
      await restore.restore();
      expect(readFileSync(f.file, 'utf8')).toBe('reviewed definition');
      expect(f.state.running).toBe(false);
      expect(() => requireNoHostRemoval(f.home)).toThrow();
      await restore.handoff();
      requireNoHostRemoval(f.home);
      expect(f.state.running).toBe(false);
      expect(existsSync(f.release)).toBe(true);
      expect(
        JSON.parse(
          readFileSync(join(f.home, 'installation/removal/restored-services.json'), 'utf8'),
        ),
      ).toEqual(original);
      if (kind === 'systemd') expect(f.state.enabled).toBe(true);
      expect(
        f.commands.some(({ args }) => args.includes('start') || args.includes('bootstrap')),
      ).toBe(false);
    } finally {
      f.close();
    }
  },
);

it('recovers a completed definition publication after losing its journal acknowledgement', async () => {
  const f = await removed();
  try {
    let writes = 0;
    const restore = new HostRemovalServiceRestore(f.guard, f.operation, {
      ...f.options,
      write: (path, value, options) => {
        if (++writes === 3) throw new Error('Lost restoration acknowledgement');
        atomicPrivateJson(path, value, options);
      },
    });
    await expect(restore.restore()).rejects.toThrow('Lost restoration acknowledgement');
    expect(readFileSync(f.file, 'utf8')).toBe('reviewed definition');
    const resumed = new HostRemovalServiceRestore(f.guard, f.operation, {
      ...f.options,
      resume: true,
    });
    await resumed.restore();
    await resumed.handoff();
    requireNoHostRemoval(f.home);
    expect(readdirSync(dirname(f.file))).toEqual([f.target.name + '.plist']);
  } finally {
    f.close();
  }
});

it.each(['daemon-reload', 'enable'] as const)(
  'observes a lost systemd %s reply without repeating that command',
  async (verb) => {
    const f = await removed('systemd');
    try {
      let dispatched = 0;
      const restore = new HostRemovalServiceRestore(f.guard, f.operation, {
        ...f.options,
        run: async (command) => {
          const result = await f.run(command);
          if (command.args[1] === verb) {
            dispatched++;
            throw new Error('Lost supervisor reply');
          }
          return result;
        },
      });
      await expect(restore.restore()).rejects.toThrow('Lost supervisor reply');
      expect(dispatched).toBe(1);
      const before = f.commands.filter(({ args }) => args[1] === verb).length;
      const resumed = new HostRemovalServiceRestore(f.guard, f.operation, {
        ...f.options,
        resume: true,
      });
      await resumed.restore();
      await resumed.handoff();
      expect(f.commands.filter(({ args }) => args[1] === verb)).toHaveLength(before);
      requireNoHostRemoval(f.home);
    } finally {
      f.close();
    }
  },
);

it.each(['source', 'authority', 'process'] as const)(
  'retains the removal fence when %s changes before hand-off',
  async (change) => {
    const f = await removed('systemd');
    let authorised = true;
    try {
      const restore = new HostRemovalServiceRestore(f.guard, f.operation, {
        ...f.options,
        authorised: () => authorised,
      });
      await restore.restore();
      if (change === 'source') writeFileSync(f.file, 'another service');
      if (change === 'authority') authorised = false;
      if (change === 'process') f.state.running = true;
      await expect(restore.handoff()).rejects.toThrow();
      expect(() => requireNoHostRemoval(f.home)).toThrow();
      expect(existsSync(f.file)).toBe(true);
    } finally {
      f.close();
    }
  },
);

it('never overwrites a definition or dangling link that appears after removal', async () => {
  const f = await removed();
  try {
    const restore = new HostRemovalServiceRestore(f.guard, f.operation, f.options);
    writeFileSync(f.file, 'new configuration', { mode: 0o600 });
    await expect(restore.restore()).rejects.toThrow('definition remains');
    expect(readFileSync(f.file, 'utf8')).toBe('new configuration');
    expect(() => requireNoHostRemoval(f.home)).toThrow();
    const link = join(dirname(f.file), 'new.plist');
    symlinkSync(join(f.home, 'missing'), link);
    expect(() =>
      restoreServiceDefinition(link, Buffer.from('reviewed').toString('base64')),
    ).toThrow();
    expect(existsSync(join(f.home, 'missing'))).toBe(false);
  } finally {
    f.close();
  }
});

it('preserves binary service definition bytes and refuses a wrong user path', async () => {
  const f = await removed();
  try {
    expect(
      () =>
        new HostRemovalServiceRestore(f.guard, f.operation, {
          ...f.options,
          userHome: join(f.home, 'elsewhere'),
        }),
    ).toThrow(/installed user path/);
    const bytes = Buffer.from([0, 255, 1, 23, 91, 0]);
    const file = join(dirname(f.file), 'binary.plist');
    restoreServiceDefinition(file, bytes.toString('base64'));
    expect(readFileSync(file)).toEqual(bytes);
  } finally {
    f.close();
  }
});

it('keeps failed enablement unresolved instead of replaying its recorded attempt', async () => {
  const f = await removed('systemd');
  try {
    let attempts = 0;
    const restore = new HostRemovalServiceRestore(f.guard, f.operation, {
      ...f.options,
      run: async (command) => {
        if (command.args[1] === 'enable') {
          attempts++;
          throw new Error('Enable failed');
        }
        return f.run(command);
      },
    });
    await expect(restore.restore()).rejects.toThrow('Enable failed');
    await expect(restore.restore()).rejects.toThrow('enablement is unconfirmed');
    expect(attempts).toBe(1);
    expect(() => requireNoHostRemoval(f.home)).toThrow();
    expect(f.state.enabled).toBe(false);
  } finally {
    f.close();
  }
});

it('never creates a missing journal during explicit continuation', async () => {
  const f = await removed();
  try {
    expect(
      () => new HostRemovalServiceRestore(f.guard, f.operation, { ...f.options, resume: true }),
    ).toThrow('Missing exact restoration journal');
    expect(existsSync(join(f.home, 'installation/removal/restore.json'))).toBe(false);
    expect(existsSync(f.file)).toBe(false);
    expect(() => requireNoHostRemoval(f.home)).toThrow();
  } finally {
    f.close();
  }
});

it('bounds restoration history across a later removal and rejects stale restoration objects', async () => {
  const f = await removed();
  try {
    const first = new HostRemovalServiceRestore(f.guard, f.operation, f.options);
    await first.restore();
    await first.handoff();
    f.controller.release();
    f.state.running = true;
    f.state.registered = true;
    const operation = await HostRemovalServiceOperation.prepare(
      f.guard,
      [await f.review()],
      f.options,
    );
    await expect(first.handoff()).rejects.toThrow();
    await operation.stop('daemon');
    const controller = f.guard.acquireController();
    try {
      await operation.unregister('daemon');
      const second = new HostRemovalServiceRestore(f.guard, operation, f.options);
      await second.restore();
      await second.handoff();
      expect(readdirSync(join(f.home, 'installation/removal')).sort()).toEqual([
        'previous-restore.json',
        'restore.json',
        'restored-services.json',
      ]);
      requireNoHostRemoval(f.home);
    } finally {
      controller.release();
    }
  } finally {
    f.close();
  }
});
