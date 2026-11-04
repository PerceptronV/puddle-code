import { existsSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { hostRemovalServicesSchema } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { HostRemovalGuard } from '../../../../src/host/removal/guard.js';
import { HostRemovalServiceOperation } from '../../../../src/host/removal/operations/services.js';
import { removalInstallationFixture as fixture } from '../../../helpers/removal-service.js';

it.each(['disable', 'reset-failed', 'daemon-reload'])(
  'observes a lost %s reply under a replacement guard and dispatches only remaining steps',
  async (lost) => {
    const f = fixture('systemd');
    let guard = f.guard;
    let controller: ReturnType<HostRemovalGuard['acquireController']> | undefined;
    try {
      const operation = await HostRemovalServiceOperation.prepare(guard, [await f.review()], {
        ...f.options,
        run: async (command) => {
          const result = await f.run(command);
          if (command.args[1] === lost) throw new Error('Lost command reply');
          return result;
        },
      });
      await operation.stop('daemon');
      f.state.failed = true;
      controller = guard.acquireController();
      await expect(operation.unregister('daemon')).rejects.toThrow('Lost command reply');
      expect(operation.unregistrationState('daemon')).toBe('started');
      controller.release();
      controller = undefined;
      guard.release();
      guard = HostRemovalGuard.acquire(f.home);
      controller = guard.acquireController();
      const resumed = HostRemovalServiceOperation.open(guard, f.options);
      await resumed.continueUnregistration('daemon');
      expect(resumed.unregistrationState('daemon')).toBe('finished');
      expect(existsSync(f.file)).toBe(false);
      expect(existsSync(f.release)).toBe(true);
      for (const command of ['stop', 'disable', 'reset-failed', 'daemon-reload'])
        expect(f.commands.filter(({ args }) => args[1] === command)).toHaveLength(1);
    } finally {
      controller?.release();
      guard.release();
      f.close();
    }
  },
);

it.each(['before-delete-intent', 'before-delete-finish', 'after-delete-finish'])(
  'continues only unattempted steps after storage fails %s',
  async (failure) => {
    const f = fixture('systemd');
    let controller: ReturnType<HostRemovalGuard['acquireController']> | undefined;
    try {
      let failed = false;
      const operation = await HostRemovalServiceOperation.prepare(f.guard, [await f.review()], {
        ...f.options,
        write: (path, value, options) => {
          const record = hostRemovalServicesSchema.parse(value);
          const state = record.actions.find(
            ({ action }) => action === 'unregister-delete-daemon',
          )!.state;
          const fail = !failed && state === (failure.endsWith('intent') ? 'started' : 'finished');
          if (fail) failed = true;
          if (fail && failure.startsWith('before')) throw new Error('Storage failed');
          atomicPrivateJson(path, value, options);
          if (fail) throw new Error('Storage reply lost');
        },
      });
      await operation.stop('daemon');
      controller = f.guard.acquireController();
      await expect(operation.unregister('daemon')).rejects.toThrow(/Storage/);
      expect(existsSync(f.file)).toBe(failure.endsWith('intent'));
      expect(f.commands.filter(({ args }) => args[1] === 'daemon-reload')).toHaveLength(0);
      const resumed = HostRemovalServiceOperation.open(f.guard, f.options);
      // Observation may finish the recorded deletion, but cannot issue the planned reload.
      await expect(resumed.observe('daemon', 'unregister')).rejects.toThrow('no recorded attempt');
      expect(f.commands.filter(({ args }) => args[1] === 'daemon-reload')).toHaveLength(0);
      await resumed.continueUnregistration('daemon');
      expect(resumed.unregistrationState('daemon')).toBe('finished');
      expect(existsSync(f.file)).toBe(false);
      expect(f.commands.filter(({ args }) => args[1] === 'disable')).toHaveLength(1);
      expect(f.commands.filter(({ args }) => args[1] === 'daemon-reload')).toHaveLength(1);
    } finally {
      controller?.release();
      f.close();
    }
  },
);

it.each(['disable', 'reset-failed', 'daemon-reload'])(
  'does not repeat a consumed %s command whose effect cannot be confirmed',
  async (lost) => {
    const f = fixture('systemd');
    let controller: ReturnType<HostRemovalGuard['acquireController']> | undefined;
    try {
      let attempts = 0;
      const operation = await HostRemovalServiceOperation.prepare(f.guard, [await f.review()], {
        ...f.options,
        run: async (command) => {
          if (command.args[1] === lost) {
            attempts++;
            throw new Error('Command failed before effect');
          }
          return f.run(command);
        },
      });
      await operation.stop('daemon');
      f.state.failed = true;
      controller = f.guard.acquireController();
      await expect(operation.unregister('daemon')).rejects.toThrow('before effect');
      const count = f.commands.length;
      const resumed = HostRemovalServiceOperation.open(f.guard, f.options);
      await expect(resumed.continueUnregistration('daemon')).rejects.toThrow();
      expect(attempts).toBe(1);
      expect(
        f.commands
          .slice(count)
          .some(({ args }) => ['disable', 'reset-failed', 'daemon-reload'].includes(args[1]!)),
      ).toBe(false);
      expect(resumed.unregistrationState('daemon')).toBe('started');
    } finally {
      controller?.release();
      f.close();
    }
  },
);

it.each(['enabled', 'running', 'source', 'authority'])(
  'refuses changed %s evidence before dispatching remaining steps',
  async (change) => {
    const f = fixture('systemd');
    let controller: ReturnType<HostRemovalGuard['acquireController']> | undefined;
    try {
      const operation = await HostRemovalServiceOperation.prepare(f.guard, [await f.review()], {
        ...f.options,
        write: (path, value, options) => {
          const record = hostRemovalServicesSchema.parse(value);
          if (
            record.actions.find(({ action }) => action === 'unregister-delete-daemon')!.state ===
            'started'
          )
            throw new Error('Storage failed before intent');
          atomicPrivateJson(path, value, options);
        },
      });
      await operation.stop('daemon');
      controller = f.guard.acquireController();
      await expect(operation.unregister('daemon')).rejects.toThrow('Storage');
      expect(
        operation.read().actions.find(({ action }) => action === 'unregister-reset-daemon')!.state,
      ).toBe('finished');
      const resumed = HostRemovalServiceOperation.open(f.guard, f.options);
      if (change === 'enabled') f.state.enabled = true;
      if (change === 'running') f.state.running = true;
      if (change === 'source') writeFileSync(f.file, 'replaced definition');
      if (change === 'authority') controller.release();
      const count = f.commands.length;
      await expect(resumed.continueUnregistration('daemon')).rejects.toThrow();
      expect(existsSync(f.file)).toBe(true);
      expect(
        f.commands
          .slice(count)
          .some(({ args }) => ['disable', 'reset-failed', 'daemon-reload'].includes(args[1]!)),
      ).toBe(false);
    } finally {
      controller?.release();
      f.close();
    }
  },
);

it('retains older coarse attempts as observation-only and rejects mixed or reordered plans', async () => {
  const f = fixture('systemd');
  let controller: ReturnType<HostRemovalGuard['acquireController']> | undefined;
  try {
    const operation = await HostRemovalServiceOperation.prepare(
      f.guard,
      [await f.review()],
      f.options,
    );
    await operation.stop('daemon');
    controller = f.guard.acquireController();
    const original = operation.read();
    for (const actions of [
      original.actions.toReversed(),
      [...original.actions, { action: 'unregister-daemon', state: 'planned' }],
      original.actions.filter(({ action }) => action !== 'unregister-reset-daemon'),
    ])
      expect(hostRemovalServicesSchema.safeParse({ ...original, actions }).success).toBe(false);
    const legacy = {
      ...original,
      actions: [
        { action: 'stop-daemon', state: 'finished' },
        { action: 'unregister-daemon', state: 'started' },
      ],
    };
    atomicPrivateJson(f.record, legacy);
    f.state.enabled = false;
    const resumed = HostRemovalServiceOperation.open(f.guard, f.options);
    const count = f.commands.length;
    await expect(resumed.continueUnregistration('daemon')).rejects.toThrow('definition remains');
    expect(f.commands).toHaveLength(count);
    expect(resumed.read()).toEqual(legacy);
  } finally {
    controller?.release();
    f.close();
  }
});
