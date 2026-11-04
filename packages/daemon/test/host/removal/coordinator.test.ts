import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { inspectHostRemoval } from '@puddle/shared/node/host-control';
import {
  prepareHostRemoval,
  finishHostRemoval,
  inspectHostRemovalResult,
} from '../../../src/host/removal/coordinator.js';
import { restoreRemovedHostServices } from '../../../src/host/removal/restoration/execute.js';
import { removalHostFixture } from '../../helpers/removal-host.js';
import { HostRemovalGuard } from '../../../src/host/removal/guard.js';

it('coordinates explicit service removal and restoration while retaining the database and selected release', async () => {
  const f = removalHostFixture();
  try {
    const review = await prepareHostRemoval(f.home, f.release, undefined, f.options);
    expect(review.owners).toEqual([]);
    expect(f.remote.enabled).toBe(false);
    expect(f.state.running).toBe(false);
    expect(existsSync(f.file)).toBe(true);
    expect(inspectHostRemovalResult(f.home)).toBeNull();
    const request = {
      id: review.id,
      fingerprint: review.fingerprint,
      attempt_id: randomUUID(),
      disposition: 'retain' as const,
    };
    await finishHostRemoval(f.home, f.release, request, f.options);
    expect(inspectHostRemovalResult(f.home)).toEqual(request);
    expect(inspectHostRemoval(f.home)).toEqual({ state: 'removed', id: review.id });
    expect(existsSync(f.file)).toBe(false);
    expect(existsSync(join(f.home, 'puddle.db'))).toBe(true);
    expect(existsSync(f.release)).toBe(true);
    expect(f.remoteCalls.filter((call) => call === '--disable-all')).toHaveLength(1);
    const count = f.commands.filter(({ args }) => args[1] === 'stop').length;
    const again = await prepareHostRemoval(f.home, f.release, review.id, f.options);
    expect(again).toEqual(review);
    await finishHostRemoval(f.home, f.release, request, f.options);
    expect(f.commands.filter(({ args }) => args[1] === 'stop')).toHaveLength(count);
    await restoreRemovedHostServices(f.home, f.release, review.id, { ...f.options, resume: false });
    expect(readFileSync(f.file, 'utf8')).toBe('reviewed definition');
    expect(f.remote.enabled).toBe(false);
  } finally {
    f.close();
  }
});

it('observes a consumed remote-disable attempt before stopping either service', async () => {
  const f = removalHostFixture();
  try {
    f.remote.loseDisableReply = true;
    await expect(prepareHostRemoval(f.home, f.release, undefined, f.options)).rejects.toThrow(
      'Lost disable',
    );
    expect(f.state.running).toBe(true);
    const state = inspectHostRemoval(f.home);
    if (state.state !== 'removing') throw new Error('Missing recorded attempt');
    const review = await prepareHostRemoval(f.home, f.release, state.id, f.options);
    expect(review.id).toBe(state.id);
    expect(f.state.running).toBe(false);
    expect(f.remoteCalls.filter((call) => call === '--disable-all')).toHaveLength(1);
  } finally {
    f.close();
  }
});

it.each(['identity', 'impact', 'authority', 'remote'] as const)(
  'refuses changed %s before final unregistration',
  async (kind) => {
    const f = removalHostFixture();
    try {
      const review = await prepareHostRemoval(f.home, f.release, undefined, f.options);
      if (kind === 'remote') f.remote.enabled = true;
      await expect(
        finishHostRemoval(
          f.home,
          f.release,
          {
            id: kind === 'identity' ? randomUUID() : review.id,
            fingerprint: kind === 'impact' ? '0'.repeat(64) : review.fingerprint,
            attempt_id: randomUUID(),
            disposition: 'stop',
          },
          { ...f.options, authorised: () => kind !== 'authority' },
        ),
      ).rejects.toThrow();
      expect(existsSync(f.file)).toBe(true);
      expect(inspectHostRemovalResult(f.home)).toBeNull();
      const guard = HostRemovalGuard.acquire(f.home);
      guard.acquireController().release();
      guard.release();
    } finally {
      f.close();
    }
  },
);

it('recovers a lost final unregistration reply by observation without replay or a false completion receipt', async () => {
  const f = removalHostFixture();
  try {
    const review = await prepareHostRemoval(f.home, f.release, undefined, f.options);
    const request = {
      id: review.id,
      fingerprint: review.fingerprint,
      attempt_id: randomUUID(),
      disposition: 'retain' as const,
    };
    f.remote.loseUnregisterReply = true;
    await expect(finishHostRemoval(f.home, f.release, request, f.options)).rejects.toThrow(
      'Lost unregistration',
    );
    expect(existsSync(f.file)).toBe(false);
    expect(inspectHostRemovalResult(f.home)).toBeNull();
    const reloads = f.commands.filter(({ args }) => args[1] === 'daemon-reload').length;
    await prepareHostRemoval(f.home, f.release, review.id, f.options);
    await finishHostRemoval(f.home, f.release, request, f.options);
    expect(inspectHostRemovalResult(f.home)).toEqual(request);
    expect(f.commands.filter(({ args }) => args[1] === 'daemon-reload')).toHaveLength(reloads);
  } finally {
    f.close();
  }
});

it.each(['disable', 'reset-failed'])(
  'continues public removal after a lost %s reply without repeating service stops',
  async (lost) => {
    const f = removalHostFixture();
    try {
      const review = await prepareHostRemoval(f.home, f.release, undefined, f.options);
      const request = {
        id: review.id,
        fingerprint: review.fingerprint,
        attempt_id: randomUUID(),
        disposition: 'retain' as const,
      };
      f.state.failed = true;
      await expect(
        finishHostRemoval(f.home, f.release, request, {
          ...f.options,
          run: async (command) => {
            const result = await f.options.run(command);
            if (command.args[1] === lost) throw new Error('Lost intermediate reply');
            return result;
          },
        }),
      ).rejects.toThrow('Lost intermediate reply');
      expect(inspectHostRemovalResult(f.home)).toBeNull();
      expect(inspectHostRemoval(f.home)).toEqual({ state: 'removing', id: review.id });
      expect(existsSync(f.file)).toBe(true);
      const fresh = await prepareHostRemoval(f.home, f.release, review.id, f.options);
      expect(fresh).toEqual(review);
      await finishHostRemoval(
        f.home,
        f.release,
        { ...request, attempt_id: randomUUID() },
        f.options,
      );
      expect(inspectHostRemoval(f.home)).toEqual({ state: 'removed', id: review.id });
      for (const command of ['stop', 'disable', 'reset-failed', 'daemon-reload'])
        expect(f.commands.filter(({ args }) => args[1] === command)).toHaveLength(1);
      expect(f.remoteCalls.filter((call) => call === '--disable-all')).toHaveLength(1);
    } finally {
      f.close();
    }
  },
);
