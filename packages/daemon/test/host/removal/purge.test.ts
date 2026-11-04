import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import {
  inspectHostRemoval,
  requireNoHostRemoval,
  readHostPurgeRecord as readHostPurge,
} from '@puddle/shared/node/host-control';
import { atomicPrivateJson } from '@puddle/shared/node';
import { removalHostFixture } from '../../helpers/removal-host.js';
import { prepareHostRemoval, finishHostRemoval } from '../../../src/host/removal/coordinator.js';
import { prepareHostPurge, applyHostPurge } from '../../../src/host/removal/purge/coordinator.js';
import { inspectHostPurge, writeHostPurge } from '../../../src/host/removal/purge/records.js';
import { restoreRemovedHostServices } from '../../../src/host/removal/restoration/execute.js';
import { git } from '../../../src/git/exec.js';
import { HostMemoryLedger } from '../../../src/runtime/resources/host/ledger.js';

async function fixture() {
  const f = removalHostFixture();
  const state: { boot: string; authorised: boolean } = { boot: randomUUID(), authorised: true };
  const options = {
    ...f.options,
    bootIdentity: async () => state.boot,
    authorised: () => state.authorised,
  };
  const review = await prepareHostRemoval(f.home, f.release, undefined, options);
  await finishHostRemoval(
    f.home,
    f.release,
    {
      id: review.id,
      fingerprint: review.fingerprint,
      attempt_id: randomUUID(),
      disposition: 'stop',
    },
    options,
  );
  return {
    ...f,
    state,
    options,
    id: review.id,
    prepare: () => prepareHostPurge(f.home, f.release, review.id, options),
    async ready() {
      await prepareHostPurge(f.home, f.release, review.id, options);
      state.boot = randomUUID();
      return prepareHostPurge(f.home, f.release, review.id, options);
    },
    async apply() {
      const current = readHostPurge(f.home)!;
      return applyHostPurge(
        f.home,
        f.release,
        { id: review.id, fingerprint: current.fingerprint!, attempt_id: randomUUID() },
        options,
      );
    },
  };
}

it('retains all purge roots and the permanent memory anchor when an unknown grant remains', async () => {
  const f = await fixture();
  const ledger = HostMemoryLedger.openExisting(f.home)!;
  try {
    ledger.compareGrant(
      { runtime_id: randomUUID(), incarnation: randomUUID(), launch_id: randomUUID() },
      0,
      0,
    );
    await f.ready();
    await expect(f.apply()).rejects.toThrow('must retire');
    expect(readHostPurge(f.home)?.phase).toBe('waiting');
    expect(existsSync(join(f.home, 'puddle.db'))).toBe(true);
    expect(existsSync(join(f.home, 'installation/removal/purge-data'))).toBe(false);
    expect(existsSync(join(f.home, 'runtime-claims/managed-memory.sqlite'))).toBe(true);
  } finally {
    ledger.close();
    f.close();
  }
});

it('retains readable intent when aggregate purge evidence exceeds its byte limit', async () => {
  const f = await fixture();
  try {
    await f.prepare();
    const before = readHostPurge(f.home)!;
    expect(() =>
      writeHostPurge(f.home, {
        ...before,
        worktrees: Array.from({ length: 4096 }, (_, index) => ({
          path: '/' + 'x'.repeat(2000) + index,
          dirty: true,
          local_only: false,
        })),
      }),
    ).toThrow('private record limit');
    expect(readHostPurge(f.home)).toEqual(before);
    expect(existsSync(join(f.home, 'puddle.db'))).toBe(true);
  } finally {
    f.close();
  }
});

it('requires a changed kernel boot and keeps installer/claim anchors through completed purge', async () => {
  const f = await fixture();
  try {
    const ledger = HostMemoryLedger.openExisting(f.home)!;
    const instance = ledger.instanceId;
    const capacity = ledger.capacityBytes;
    ledger.close();
    const memoryInode = lstatSync(join(f.home, 'runtime-claims/managed-memory.sqlite')).ino;
    const inode = lstatSync(join(f.home, 'bin/.install-lock')).ino;
    mkdirSync(join(f.home, 'profiles'), { mode: 0o700 });
    writeFileSync(join(f.home, 'profiles/credentials'), 'fixture secret');
    const waiting = await f.prepare();
    expect(waiting.phase).toBe('reboot_required');
    expect(existsSync(join(f.home, 'puddle.db'))).toBe(true);
    await expect(
      restoreRemovedHostServices(f.home, f.release, f.id, { ...f.options, resume: false }),
    ).rejects.toThrow('purge');
    const ready = await f.ready();
    expect(ready.phase).toBe('ready');
    const earlierBoot = readHostPurge(f.home)!.boot_id;
    f.state.boot = earlierBoot;
    await expect(f.apply()).rejects.toThrow('Reboot');
    f.state.boot = randomUUID();
    await f.apply();
    expect(inspectHostPurge(f.home)?.phase).toBe('complete');
    expect(existsSync(join(f.home, 'profiles'))).toBe(false);
    expect(existsSync(join(f.home, 'puddle.db'))).toBe(false);
    expect(lstatSync(join(f.home, 'bin/.install-lock')).ino).toBe(inode);
    expect(lstatSync(join(f.home, 'runtime-claims/managed-memory.sqlite')).ino).toBe(memoryInode);
    const retained = HostMemoryLedger.openExisting(f.home)!;
    try {
      expect(retained.instanceId).toBe(instance);
      expect(retained.capacityBytes).toBe(capacity);
      expect(() => retained.requireEmpty()).not.toThrow();
    } finally {
      retained.close();
    }
    expect(existsSync(f.release)).toBe(true);
    expect(inspectHostRemoval(f.home)).toEqual({ state: 'removed', id: f.id });
  } finally {
    f.close();
  }
});

it('refuses unknown runtime directories and unavailable boot identity before recording a barrier', async () => {
  const f = await fixture();
  try {
    await expect(
      prepareHostPurge(f.home, f.release, f.id, { ...f.options, bootIdentity: async () => null }),
    ).rejects.toThrow('boot identity');
    mkdirSync(join(f.home, 'runtimes', randomUUID()), { recursive: true, mode: 0o700 });
    await expect(f.prepare()).rejects.toThrow('Unknown or missing runtime');
    expect(readHostPurge(f.home)).toBeNull();
  } finally {
    f.close();
  }
});

it('reviews dirty and unpushed work, then rejects changed review and expired authority', async () => {
  const f = await fixture();
  try {
    const path = join(f.home, 'worktrees/1/session');
    mkdirSync(path, { recursive: true, mode: 0o700 });
    await git(['init', '-q'], { cwd: path });
    writeFileSync(join(path, 'work.txt'), 'original');
    await git(['add', '.'], { cwd: path });
    await git(
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'fixture',
      ],
      { cwd: path },
    );
    writeFileSync(join(path, 'untracked.txt'), 'unsaved');
    const ready = await f.ready();
    expect(ready.worktrees).toEqual([{ path, dirty: true, local_only: true }]);
    writeFileSync(join(path, 'new.txt'), 'changed after review');
    await expect(f.apply()).rejects.toThrow('review changed');
    expect(existsSync(path)).toBe(true);
    await f.prepare();
    f.state.authorised = false;
    await expect(f.apply()).rejects.toThrow('authority');
    expect(existsSync(path)).toBe(true);
  } finally {
    f.close();
  }
});

it('fails closed on unreadable Git state rather than treating inspection failure as a clean worktree', async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.home, 'worktrees/1/not-a-repository'), { recursive: true, mode: 0o700 });
    await f.prepare();
    f.state.boot = randomUUID();
    await expect(f.prepare()).rejects.toThrow('git');
    expect(readHostPurge(f.home)!.fingerprint).toBeNull();
  } finally {
    f.close();
  }
});

it('recovers a worktree detachment whose rename completed before the journal update', async () => {
  const f = await fixture();
  try {
    const path = join(f.home, 'worktrees/1/session');
    mkdirSync(path, { recursive: true, mode: 0o700 });
    await git(['init', '-q'], { cwd: path });
    await f.ready();
    const record = readHostPurge(f.home)!;
    const index = record.roots.findIndex((root) => root.name === 'worktrees');
    const quarantine = join(f.home, 'installation/removal/purge-data');
    mkdirSync(quarantine, { mode: 0o700 });
    atomicPrivateJson(join(f.home, 'installation/removal/purge.json'), {
      ...record,
      phase: 'deleting',
      attempt_id: randomUUID(),
    });
    renameSync(join(f.home, 'worktrees'), join(quarantine, String(index)));
    await f.prepare();
    await f.apply();
    expect(inspectHostPurge(f.home)?.phase).toBe('complete');
  } finally {
    f.close();
  }
});

it('continues bounded quarantine deletion and never follows links or deletes recreated source paths', async () => {
  const f = await fixture();
  try {
    const data = join(f.home, 'profiles');
    mkdirSync(data, { mode: 0o700 });
    const outside = join(f.home, 'bin/keep-fixture');
    writeFileSync(outside, 'keep');
    symlinkSync(outside, join(data, 'linked'));
    for (let index = 0; index < 600; index++) writeFileSync(join(data, String(index)), 'fixture');
    await f.ready();
    await f.apply();
    expect(inspectHostPurge(f.home)?.phase).toBe('deleting');
    expect(readHostPurge(f.home)!.roots.every((root) => root.state !== 'planned')).toBe(true);
    mkdirSync(data, { mode: 0o700 });
    writeFileSync(join(data, 'new-data'), 'not reviewed');
    await f.prepare();
    await f.apply();
    expect(inspectHostPurge(f.home)?.phase).toBe('complete');
    expect(readFileSync(outside, 'utf8')).toBe('keep');
    expect(readFileSync(join(data, 'new-data'), 'utf8')).toBe('not reviewed');
  } finally {
    f.close();
  }
});

it('purges socket directory entries only within the reviewed quarantined tree', async () => {
  const f = await fixture();
  const server = createServer();
  try {
    const directory = join(f.home, 'fixture-sockets');
    mkdirSync(directory, { mode: 0o700 });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(join(directory, 'socket'), resolve);
    });
    await f.ready();
    await f.apply();
    expect(existsSync(directory)).toBe(false);
    expect(inspectHostPurge(f.home)?.phase).toBe('complete');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
  }
});

it.each(['deleting', 'complete'] as const)(
  'recovers the %s completion hand-off without restoring services or repeating deletion',
  async (phase) => {
    const f = await fixture();
    try {
      await f.ready();
      await f.apply();
      const complete = readHostPurge(f.home)!;
      atomicPrivateJson(join(f.home, 'installation/removal/purge.json'), {
        ...complete,
        phase,
      });
      expect(() => requireNoHostRemoval(f.home)).toThrow('removal');
      expect(inspectHostPurge(f.home)?.phase).toBe('deleting');
      const review = await f.prepare();
      if (phase === 'deleting') {
        expect(review.phase).toBe('deleting');
        await f.apply();
      }
      expect(inspectHostPurge(f.home)?.phase).toBe('complete');
      expect(() => requireNoHostRemoval(f.home)).not.toThrow();
    } finally {
      f.close();
    }
  },
);
