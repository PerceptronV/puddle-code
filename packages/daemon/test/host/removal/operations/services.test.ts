import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import { requireNoHostRemoval } from '@puddle/shared/node/host-control';
import { HostUpdateOperations } from '../../../../src/updates/operations/store.js';
import { HostRemovalServiceOperation } from '../../../../src/host/removal/operations/services.js';
import { HostRemovalGuard } from '../../../../src/host/removal/guard.js';
import { reviewRemovalService } from '../../../../src/host/removal/services.js';
import { removalServiceFixture } from '../../../helpers/removal-service.js';

function fixture(kind: 'systemd' | 'launchd' = 'launchd') {
  const f = removalServiceFixture(kind);
  const release = join(f.home, 'bin/versions/0.4.0~abc123');
  mkdirSync(release, { recursive: true, mode: 0o700 });
  symlinkSync(release, join(f.home, 'bin/current'));
  return {
    ...f,
    release,
    record: join(f.home, 'installation/removal/services.json'),
    options: { authorised: () => true, run: f.run },
    review: () =>
      reviewRemovalService(f.guard, f.target, 'daemon', f.pid, { userHome: f.home, run: f.run }),
  };
}

it('cancels only an unattempted removal and preserves the latest cancelled private review', async () => {
  const f = fixture();
  try {
    const review = await f.review();
    const updates = new HostUpdateOperations(f.home);
    const first = await HostRemovalServiceOperation.prepare(f.guard, [review], f.options);
    expect(() => updates.begin([{ component: 'runtime', version: '0.4.0' }])).toThrow(
      /recorded host removal/,
    );
    expect(updates.read()).toBeNull();
    expect(() => requireNoHostRemoval(f.home)).toThrow(/recorded host removal/);
    first.cancel();
    requireNoHostRemoval(f.home);
    expect(f.state.running).toBe(true);
    expect(existsSync(f.file)).toBe(true);
    expect(f.commands.some(({ args }) => args[0] === 'bootout')).toBe(false);
    expect(() => first.read()).toThrow();
    const second = await HostRemovalServiceOperation.prepare(f.guard, [review], f.options);
    const cancelled = second.read();
    expect(() => first.cancel()).toThrow(/accepted operation/);
    expect(second.read()).toEqual(cancelled);
    second.cancel();
    expect(
      JSON.parse(
        readFileSync(join(f.home, 'installation/removal/cancelled-services.json'), 'utf8'),
      ),
    ).toEqual(cancelled);
    const third = await HostRemovalServiceOperation.prepare(f.guard, [review], f.options);
    await third.stop('daemon');
    expect(() => third.cancel()).toThrow(/requires recovery/);
    expect(() => requireNoHostRemoval(f.home)).toThrow(/recorded host removal/);
  } finally {
    f.close();
  }
});

it('retains reviewed private sources and resumes only unstarted work under a new guard', async () => {
  const f = fixture();
  let replacement: HostRemovalGuard | undefined;
  let controller: ReturnType<HostRemovalGuard['acquireController']> | undefined;
  try {
    const review = await f.review();
    const operation = await HostRemovalServiceOperation.prepare(f.guard, [review], f.options);
    const originalServices = operation.read().services;
    expect(operation.read().services[0]!.source).toBe(
      Buffer.from('reviewed definition').toString('base64'),
    );
    expect(statSync(f.record).mode & 0o777).toBe(0o600);
    await expect(HostRemovalServiceOperation.prepare(f.guard, [review], f.options)).rejects.toThrow(
      'already recorded',
    );
    await expect(operation.unregister('daemon')).rejects.toThrow(/controller/);
    await operation.stop('daemon');
    expect(existsSync(f.file)).toBe(true);
    f.guard.release();
    replacement = HostRemovalGuard.acquire(f.home);
    const resumed = HostRemovalServiceOperation.open(replacement, f.options);
    await expect(resumed.stop('daemon')).rejects.toThrow('already attempted');
    controller = replacement.acquireController();
    await resumed.unregister('daemon');
    expect(resumed.read().actions.map(({ state }) => state)).toEqual(['finished', 'finished']);
    expect(existsSync(f.file)).toBe(false);
    expect(existsSync(f.release)).toBe(true);
    expect(resumed.read().services).toEqual(originalServices);
  } finally {
    controller?.release();
    replacement?.release();
    f.close();
  }
});

it.each(['before-intent', 'after-intent', 'before-finish', 'after-finish'] as const)(
  'retains service command uncertainty when storage fails %s',
  async (failure) => {
    const f = fixture();
    try {
      let writes = 0;
      const options = {
        ...f.options,
        write: (path: string, value: unknown, settings?: { syncDirectory?: boolean }) => {
          const fail = ++writes === (failure.endsWith('intent') ? 2 : 3);
          if (fail && failure.startsWith('before')) throw new Error('storage failed');
          atomicPrivateJson(path, value, settings);
          if (fail) throw new Error('storage reply lost');
        },
      };
      const operation = await HostRemovalServiceOperation.prepare(
        f.guard,
        [await f.review()],
        options,
      );
      await expect(operation.stop('daemon')).rejects.toThrow('storage');
      expect(f.commands.filter(({ args }) => args[0] === 'bootout')).toHaveLength(
        failure.endsWith('intent') ? 0 : 1,
      );
      const resumed = HostRemovalServiceOperation.open(f.guard, f.options);
      if (failure === 'before-intent') {
        await expect(resumed.observe('daemon', 'stop')).rejects.toThrow('no recorded attempt');
        await resumed.stop('daemon');
      } else {
        await expect(resumed.stop('daemon')).rejects.toThrow('already attempted');
        if (failure === 'after-intent') {
          await expect(resumed.observe('daemon', 'stop')).rejects.toThrow(
            'shutdown is unconfirmed',
          );
          expect(f.state.running).toBe(true);
          return;
        }
        await resumed.observe('daemon', 'stop');
      }
      expect(resumed.read().actions[0]!.state).toBe('finished');
    } finally {
      f.close();
    }
  },
);

it('observes a lost reload after unlink without repeating unregistration', async () => {
  const f = fixture('systemd');
  let controller: ReturnType<HostRemovalGuard['acquireController']> | undefined;
  try {
    const operation = await HostRemovalServiceOperation.prepare(f.guard, [await f.review()], {
      ...f.options,
      run: async (command) => {
        const result = await f.run(command);
        if (command.args[1] === 'daemon-reload') throw new Error('reload reply lost');
        return result;
      },
    });
    await operation.stop('daemon');
    controller = f.guard.acquireController();
    await expect(operation.unregister('daemon')).rejects.toThrow('reload reply lost');
    expect(existsSync(f.file)).toBe(false);
    const resumed = HostRemovalServiceOperation.open(f.guard, f.options);
    await expect(resumed.unregister('daemon')).rejects.toThrow('already attempted');
    const mutations = f.commands.filter(({ args }) =>
      ['stop', 'disable', 'daemon-reload'].includes(args[1]!),
    ).length;
    await resumed.observe('daemon', 'unregister');
    expect(resumed.read().actions[1]!.state).toBe('finished');
    expect(
      f.commands.filter(({ args }) => ['stop', 'disable', 'daemon-reload'].includes(args[1]!)),
    ).toHaveLength(mutations);
    writeFileSync(f.file, 'replacement definition', { mode: 0o600 });
    await expect(resumed.observe('daemon', 'unregister')).rejects.toThrow('definition remains');
    expect(readFileSync(f.file, 'utf8')).toBe('replacement definition');
  } finally {
    controller?.release();
    f.close();
  }
});

it.each(['authority', 'selector', 'source', 'journal'] as const)(
  'refuses changed %s without dispatching a stop',
  async (change) => {
    const f = fixture();
    let authorised = true;
    try {
      const operation = await HostRemovalServiceOperation.prepare(f.guard, [await f.review()], {
        ...f.options,
        authorised: () => authorised,
      });
      if (change === 'authority') authorised = false;
      if (change === 'selector') {
        const other = join(f.home, 'bin/versions/0.4.0~def456');
        mkdirSync(other, { mode: 0o700 });
        unlinkSync(join(f.home, 'bin/current'));
        symlinkSync(other, join(f.home, 'bin/current'));
      }
      if (change === 'source') writeFileSync(f.file, 'changed');
      if (change === 'journal') {
        const record = operation.read();
        record.services[0]!.source = Buffer.from('changed').toString('base64');
        atomicPrivateJson(f.record, record);
      }
      await expect(operation.stop('daemon')).rejects.toThrow();
      expect(f.commands.some(({ args }) => args[0] === 'bootout')).toBe(false);
      expect(f.state.running).toBe(true);
    } finally {
      f.close();
    }
  },
);

it('does not recreate missing or malformed removal evidence', async () => {
  const f = fixture();
  try {
    expect(() => HostRemovalServiceOperation.open(f.guard, f.options)).toThrow();
    const operation = await HostRemovalServiceOperation.prepare(
      f.guard,
      [await f.review()],
      f.options,
    );
    const original = operation.read();
    for (const record of [
      { ...original, actions: original.actions.toReversed() },
      {
        ...original,
        actions: original.actions.map((item) => ({
          ...item,
          state: item.action.startsWith('unregister') ? 'finished' : 'planned',
        })),
      },
      { ...original, services: [original.services[0], original.services[0]] },
    ]) {
      atomicPrivateJson(f.record, record);
      expect(() => HostRemovalServiceOperation.open(f.guard, f.options)).toThrow();
    }
    writeFileSync(f.record, '{');
    await expect(
      HostRemovalServiceOperation.prepare(f.guard, [await f.review()], f.options),
    ).rejects.toThrow();
    expect(readFileSync(f.record, 'utf8')).toBe('{');
  } finally {
    f.close();
  }
});
