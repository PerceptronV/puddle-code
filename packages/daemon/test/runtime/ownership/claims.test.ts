import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digest } from '@puddle/shared/node';
import { acquireHostClaim, HostClaimBusy } from '../../../src/security/claims.js';
import {
  acquireRuntimeController,
  acquireRuntimeControllerWhenAvailable,
  readRuntimeController,
} from '../../../src/runtime/ownership/storage.js';
import { HostMemoryLedger } from '../../../src/runtime/resources/host/ledger.js';

const homes: string[] = [];
function home() {
  const value = mkdtempSync(join(tmpdir(), 'puddle-runtime-claim-'));
  homes.push(value);
  return value;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('runtime ownership', () => {
  it('excludes a second owner, keeps distinct claims independent and releases idempotently', () => {
    const path = home();
    const first = acquireHostClaim(path, 'runtime:a');
    const other = acquireHostClaim(path, 'runtime:b');
    try {
      expect(() => acquireHostClaim(path, 'runtime:a')).toThrow(HostClaimBusy);
    } finally {
      first.release();
      other.release();
    }
    first.release();
    acquireHostClaim(path, 'runtime:a').release();
  });

  it('advances the controller epoch only under exclusive ownership', () => {
    const path = home();
    const first = acquireRuntimeController(path);
    try {
      expect(() => acquireRuntimeController(path)).toThrow(HostClaimBusy);
      expect(readRuntimeController(path)).toEqual(first.record);
    } finally {
      first.release();
    }
    expect(readRuntimeController(path).active).toBe(false);
    const second = acquireRuntimeController(path);
    try {
      expect(second.record.epoch).toBe(first.record.epoch + 1);
      expect(second.record.id).not.toBe(first.record.id);
    } finally {
      second.release();
    }
  });

  it('rejects a symlink in the lock namespace', () => {
    const path = home();
    acquireHostClaim(path, 'initialise').release();
    const target = join(path, 'target');
    writeFileSync(target, '', { mode: 0o600 });
    symlinkSync(target, join(path, 'runtime-claims', `${digest('replacement')}.sqlite`));
    expect(() => acquireHostClaim(path, 'replacement')).toThrow(/private/);
  });

  it('waits asynchronously for a surviving owner writer without replacing the ledger', async () => {
    const path = home();
    const first = acquireRuntimeController(path);
    first.release();
    const original = HostMemoryLedger.openExisting(path)!;
    const instance = original.instanceId;
    const capacity = original.capacityBytes;
    original.close();
    const writer = new Database(join(path, 'runtime-claims', 'managed-memory.sqlite'));
    writer.exec('BEGIN EXCLUSIVE');
    let unlocked = false;
    const release = setTimeout(() => {
      writer.exec('ROLLBACK');
      unlocked = true;
    }, 75);
    try {
      const second = await acquireRuntimeControllerWhenAvailable(path);
      try {
        expect(unlocked).toBe(true);
        expect(second.record.epoch).toBe(first.record.epoch + 1);
        const reopened = HostMemoryLedger.openExisting(path)!;
        try {
          expect(reopened.instanceId).toBe(instance);
          expect(reopened.capacityBytes).toBe(capacity);
        } finally {
          reopened.close();
        }
      } finally {
        second.release();
      }
    } finally {
      clearTimeout(release);
      writer.close();
    }
  });

  it('bounds busy retries and does not retry an existing controller claim', async () => {
    const path = home();
    const first = acquireRuntimeController(path);
    try {
      await expect(acquireRuntimeControllerWhenAvailable(path)).rejects.toBeInstanceOf(
        HostClaimBusy,
      );
    } finally {
      first.release();
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const busy = Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
    vi.spyOn(HostMemoryLedger, 'initialise').mockImplementation(() => {
      throw busy;
    });
    const rejected = expect(acquireRuntimeControllerWhenAvailable(path)).rejects.toBe(busy);
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
