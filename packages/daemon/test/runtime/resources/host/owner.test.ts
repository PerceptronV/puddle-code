import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireHostClaim, HostClaimBusy } from '../../../../src/security/claims.js';
import { retireMissingRuntime } from '../../../../src/runtime/ownership/discovery.js';
import { HostMemoryLedger } from '../../../../src/runtime/resources/host/ledger.js';
import {
  prepare,
  launchOwner,
  waitForOwner,
  bundleDir,
  environment,
  children,
} from '../../../helpers/runtime-fixture.js';

it('refuses an unadmitted launch before consuming intent or spawning a PTY', async () => {
  const f = prepare();
  const child = spawn(
    process.execPath,
    [join(bundleDir, 'puddler.mjs'), '--home', f.home, '--runtime', f.launch.identity.runtime_id],
    {
      env: environment(f.home),
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  children.push(child);
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  await once(child, 'exit');
  expect(child.exitCode).not.toBe(0);
  expect(errors).toContain('pre-dispatch memory admission');
  expect(existsSync(join(f.directory, 'consumed.json'))).toBe(false);
  expect(existsSync(join(f.directory, 'state.json'))).toBe(false);
  const ledger = HostMemoryLedger.openExisting(f.home)!;
  try {
    ledger.requireEmpty();
  } finally {
    ledger.close();
  }
});

it('retains admitted memory after graceful shutdown until the actual owner process exits', async () => {
  const f = prepare();
  const owner = launchOwner(f.home, f.launch.identity.runtime_id, 'memory-owner.mjs');
  try {
    await waitForOwner(owner, f.directory);
    const stopped = once(owner.child.stdout!, 'data');
    owner.child.kill('SIGTERM');
    expect(String((await stopped)[0])).toContain('execution-stopped');
    expect(owner.child.exitCode).toBeNull();
    const execution = acquireHostClaim(f.home, `runtime:${f.launch.identity.runtime_id}`);
    execution.release();
    expect(() =>
      acquireHostClaim(f.home, `runtime-memory:${f.launch.identity.runtime_id}`),
    ).toThrow(HostClaimBusy);
    expect(retireMissingRuntime(f.home, f.launch.identity, () => {})).toBe('owned');
    const ledger = HostMemoryLedger.openExisting(f.home)!;
    try {
      expect(ledger.readGrant(f.launch.identity)!.bytes).toBeGreaterThan(40 * 1024 * 1024);
    } finally {
      ledger.close();
    }
    const exited = once(owner.child, 'exit');
    owner.child.kill('SIGUSR1');
    await exited;
    expect(retireMissingRuntime(f.home, f.launch.identity, () => {})).toBe('retired');
    const final = HostMemoryLedger.openExisting(f.home)!;
    try {
      final.requireEmpty();
    } finally {
      final.close();
    }
  } finally {
    if (owner.child.exitCode === null && owner.child.signalCode === null) {
      const exited = once(owner.child, 'exit');
      owner.child.kill('SIGKILL');
      await exited;
    }
  }
});
