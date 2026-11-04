import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { digest } from '@puddle/shared/node';
import { acquireRuntimeClaim, RuntimeClaimBusy } from '../../../src/runtime/ownership/claims.js';
import {
  acquireRuntimeController,
  readRuntimeController,
} from '../../../src/runtime/ownership/storage.js';

const homes: string[] = [];
function home() {
  const value = mkdtempSync(join(tmpdir(), 'puddle-runtime-claim-'));
  homes.push(value);
  return value;
}
afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('runtime ownership', () => {
  it('excludes a second owner, keeps distinct claims independent and releases idempotently', () => {
    const path = home();
    const first = acquireRuntimeClaim(path, 'runtime:a');
    const other = acquireRuntimeClaim(path, 'runtime:b');
    try {
      expect(() => acquireRuntimeClaim(path, 'runtime:a')).toThrow(RuntimeClaimBusy);
    } finally {
      first.release();
      other.release();
    }
    first.release();
    acquireRuntimeClaim(path, 'runtime:a').release();
  });

  it('advances the controller epoch only under exclusive ownership', () => {
    const path = home();
    const first = acquireRuntimeController(path);
    try {
      expect(() => acquireRuntimeController(path)).toThrow(RuntimeClaimBusy);
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
    acquireRuntimeClaim(path, 'initialise').release();
    const target = join(path, 'target');
    writeFileSync(target, '', { mode: 0o600 });
    symlinkSync(target, join(path, 'runtime-claims', `${digest('replacement')}.sqlite`));
    expect(() => acquireRuntimeClaim(path, 'replacement')).toThrow(/private/);
  });
});
