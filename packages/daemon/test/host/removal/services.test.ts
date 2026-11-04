import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import {
  reviewRemovalService,
  stopRemovalService,
  unregisterRemovalService,
} from '../../../src/host/removal/services.js';
import { acquireHostClaim } from '../../../src/security/claims.js';
import { acquireInstallationLock } from '../../../src/host/installation/lock.js';
import { removalServiceFixture } from '../../helpers/removal-service.js';

it.each(['systemd', 'launchd'] as const)(
  'stops and unregisters the reviewed %s service under retained exclusion',
  async (kind) => {
    const f = removalServiceFixture(kind);
    let controller: ReturnType<typeof f.guard.acquireController> | undefined;
    try {
      const run: typeof f.run = async (command) => {
        for (const scope of ['host-update-coordinator', 'host-update-execution'])
          expect(() => acquireHostClaim(f.home, scope)).toThrow();
        expect(() => acquireInstallationLock(f.home)).toThrow();
        expect(command.inheritedFds).toHaveLength(1);
        return f.run(command);
      };
      const review = await reviewRemovalService(f.guard, f.target, 'daemon', f.pid, {
        userHome: f.home,
        run,
      });
      const stop = vi.fn();
      await stopRemovalService(f.guard, review, () => true, stop, run);
      expect(stop).toHaveBeenCalledOnce();
      expect(readFileSync(f.file, 'utf8')).toBe('reviewed definition');
      await expect(
        unregisterRemovalService(f.guard, review, () => true, vi.fn(), run),
      ).rejects.toThrow(/controller/);
      controller = f.guard.acquireController();
      expect(() => f.guard.release()).toThrow(/Drain/);
      const unregister = vi.fn();
      await unregisterRemovalService(f.guard, review, () => true, unregister, run);
      expect(unregister).toHaveBeenCalledOnce();
      expect(existsSync(f.file)).toBe(false);
      expect(f.state.registered).toBe(false);
    } finally {
      controller?.release();
      f.close();
    }
  },
);

it.each(['systemd', 'launchd'] as const)(
  'observes a lost %s stop reply without sending another stop',
  async (kind) => {
    const f = removalServiceFixture(kind);
    try {
      const review = await reviewRemovalService(f.guard, f.target, 'daemon', f.pid, {
        userHome: f.home,
        run: f.run,
      });
      let stops = 0;
      await stopRemovalService(
        f.guard,
        review,
        () => true,
        vi.fn(),
        async (command) => {
          const result = await f.run(command);
          if (command.args.includes(kind === 'systemd' ? 'stop' : 'bootout')) {
            stops++;
            throw new Error('Lost reply');
          }
          return result;
        },
      );
      expect(stops).toBe(1);
      expect(existsSync(f.file)).toBe(true);
    } finally {
      f.close();
    }
  },
);

it('records an idle launchd unload before its only mutation', async () => {
  const f = removalServiceFixture('launchd', false);
  try {
    const review = await reviewRemovalService(f.guard, f.target, 'daemon', null, {
      userHome: f.home,
      run: f.run,
    });
    const intent = vi.fn();
    await stopRemovalService(
      f.guard,
      review,
      () => true,
      intent,
      async (command) => {
        if (command.args[0] === 'bootout') expect(intent).toHaveBeenCalledOnce();
        return f.run(command);
      },
    );
    expect(intent).toHaveBeenCalledOnce();
  } finally {
    f.close();
  }
});

it('requires exact disabled/failed systemd cleanup before deleting the source', async () => {
  const f = removalServiceFixture('systemd', false);
  const controller = f.guard.acquireController();
  f.state.failed = true;
  try {
    const review = await reviewRemovalService(f.guard, f.target, 'daemon', null, {
      userHome: f.home,
      run: f.run,
    });
    await unregisterRemovalService(f.guard, review, () => true, vi.fn(), f.run);
    expect(
      f.commands
        .filter((command) =>
          ['disable', 'reset-failed', 'daemon-reload'].includes(command.args[1]!),
        )
        .map((command) => command.args),
    ).toEqual([
      ['--user', 'disable', f.target.name],
      ['--user', 'reset-failed', f.target.name],
      ['--user', 'daemon-reload'],
    ]);
    expect(existsSync(f.file)).toBe(false);
  } finally {
    controller.release();
    f.close();
  }
});

it.each(['authority', 'source', 'running', 'fragment'] as const)(
  'refuses changed %s before deleting a service definition',
  async (change) => {
    const f = removalServiceFixture('systemd', false);
    const controller = f.guard.acquireController();
    try {
      const review = await reviewRemovalService(f.guard, f.target, 'daemon', null, {
        userHome: f.home,
        run: f.run,
      });
      if (change === 'source') writeFileSync(f.file, 'new definition');
      if (change === 'running') f.state.running = true;
      if (change === 'fragment') f.state.fragment += '-changed';
      const intent = vi.fn();
      await expect(
        unregisterRemovalService(f.guard, review, () => change !== 'authority', intent, f.run),
      ).rejects.toThrow();
      expect(intent).not.toHaveBeenCalled();
      expect(existsSync(f.file)).toBe(true);
    } finally {
      controller.release();
      f.close();
    }
  },
);

it('preserves a definition edited during disable and refuses a lost disable reply', async () => {
  const f = removalServiceFixture('systemd', false);
  const controller = f.guard.acquireController();
  try {
    const review = await reviewRemovalService(f.guard, f.target, 'daemon', null, {
      userHome: f.home,
      run: f.run,
    });
    await expect(
      unregisterRemovalService(
        f.guard,
        review,
        () => true,
        vi.fn(),
        async (command) => {
          if (command.args[1] === 'disable') throw new Error('Lost disable reply');
          return f.run(command);
        },
      ),
    ).rejects.toThrow('Lost disable reply');
    expect(existsSync(f.file)).toBe(true);
    await expect(
      unregisterRemovalService(
        f.guard,
        review,
        () => true,
        vi.fn(),
        async (command) => {
          const result = await f.run(command);
          if (command.args[1] === 'disable') writeFileSync(f.file, 'new definition');
          return result;
        },
      ),
    ).rejects.toThrow(/source changed/);
    expect(readFileSync(f.file, 'utf8')).toBe('new definition');
  } finally {
    controller.release();
    f.close();
  }
});

it('does not claim unregistration when the manager disappears after unlink', async () => {
  const f = removalServiceFixture('launchd', false);
  const controller = f.guard.acquireController();
  f.state.registered = false;
  try {
    const review = await reviewRemovalService(f.guard, f.target, 'daemon', null, {
      userHome: f.home,
      run: f.run,
    });
    await expect(
      unregisterRemovalService(
        f.guard,
        review,
        () => true,
        vi.fn(),
        async (command) => {
          if (!existsSync(f.file))
            return { exitCode: 113, stdout: '', stderr: 'Manager unavailable' };
          return f.run(command);
        },
      ),
    ).rejects.toThrow(/failed/);
  } finally {
    controller.release();
    f.close();
  }
});
