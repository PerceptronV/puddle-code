import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { REMOTE_POLICY } from '@puddle/shared';
import { DeviceStore } from '../../src/devices.js';

const peer = '12D3KooW' + 'a'.repeat(44);
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-maintenance-grants-'));
  let now = 1000;
  const store = new DeviceStore(directory, () => now);
  const host = randomUUID();
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(() => store.close());
  const device = store.enrol(store.invite().invitation, peer, 'owner', 'Phone');
  return {
    directory,
    store,
    host,
    device,
    time: (value: number) => {
      now = value;
    },
  };
}

it('requires separate host approval and binds the grant to exact device, peer, account and registration', () => {
  const f = fixture();
  expect(() => f.store.setMaintenance(f.device.id, true, 'owner', f.host)).toThrow(
    'approved browser',
  );
  f.store.approve(f.device.id);
  expect(f.store.maintenanceClaim(f.device.id, peer, 'owner', f.host)).toBeNull();
  expect(f.store.list()[0]?.maintenance).toBe(false);
  expect(() => f.store.setMaintenance(f.device.id, true, 'other', f.host)).toThrow(
    'approved browser',
  );
  const changed = vi.fn();
  f.store.onChange(changed);
  f.store.setMaintenance(f.device.id, true, 'owner', f.host);
  const claim = f.store.maintenanceClaim(f.device.id, peer, 'owner', f.host)!;
  expect(claim).toMatchObject({ device: f.device.id, peer, account: 'owner', host: f.host });
  expect(f.store.list()[0]?.maintenance).toBe(true);
  expect(f.store.list(randomUUID())[0]?.maintenance).toBe(false);
  for (const [id, actualPeer, account, host] of [
    [randomUUID(), peer, 'owner', f.host],
    [f.device.id, peer + 'x', 'owner', f.host],
    [f.device.id, peer, 'other', f.host],
    [f.device.id, peer, 'owner', randomUUID()],
  ])
    expect(f.store.maintenanceClaim(id!, actualPeer!, account!, host!)).toBeNull();
  f.store.setMaintenance(f.device.id, true, 'owner', f.host);
  expect(f.store.maintenanceClaim(f.device.id, peer, 'owner', f.host)).toEqual(claim);
  expect(changed).toHaveBeenCalledTimes(1);
  f.store.setMaintenance(f.device.id, false, 'owner', f.host);
  expect(f.store.maintenanceClaim(f.device.id, peer, 'owner', f.host)).toBeNull();
  f.store.setMaintenance(f.device.id, true, 'owner', f.host);
  expect(f.store.maintenanceClaim(f.device.id, peer, 'owner', f.host)?.grant).not.toBe(claim.grant);
  expect(changed).toHaveBeenCalledTimes(3);
});

it.each(['idle', 'absolute'] as const)(
  'expires maintenance authority with the browser %s limit',
  (kind) => {
    const f = fixture();
    f.store.approve(f.device.id);
    f.store.setMaintenance(f.device.id, true, 'owner', f.host);
    f.time(1000 + (kind === 'idle' ? REMOTE_POLICY.idleMs : REMOTE_POLICY.absoluteMs));
    if (kind === 'absolute') f.store.touch(f.device.id);
    expect(f.store.maintenanceClaim(f.device.id, peer, 'owner', f.host)).toBeNull();
    expect(f.store.list()[0]?.maintenance).toBe(false);
    expect(() => f.store.setMaintenance(f.device.id, true, 'owner', f.host)).toThrow();
  },
);

it('does not transfer maintenance permission when the same browser pairs again', () => {
  const f = fixture();
  f.store.approve(f.device.id);
  f.store.setMaintenance(f.device.id, true, 'owner', f.host);
  const replacement = f.store.enrol(f.store.invite().invitation, peer, 'owner', 'Phone again');
  f.store.approve(replacement.id);
  expect(f.store.maintenanceClaim(f.device.id, peer, 'owner', f.host)).toBeNull();
  expect(f.store.maintenanceClaim(replacement.id, peer, 'owner', f.host)).toBeNull();
  f.store.setMaintenance(replacement.id, true, 'owner', f.host);
  f.store.revoke(replacement.id);
  expect(f.store.maintenanceClaim(replacement.id, peer, 'owner', f.host)).toBeNull();
});

it('migrates existing schema3 approvals without granting maintenance and persists explicit grants', () => {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-maintenance-migration-'));
  let store = new DeviceStore(directory);
  const host = randomUUID();
  const device = store.enrol(store.invite().invitation, peer, 'owner', 'Existing browser');
  store.approve(device.id);
  store.close();
  const previous = new Database(join(directory, 'devices.db'));
  previous.exec('DROP TABLE maintenance_grants; PRAGMA user_version = 3;');
  previous.close();
  store = new DeviceStore(directory);
  try {
    expect(store.valid(device.id, peer, 'owner')).toBe(true);
    expect(store.maintenanceClaim(device.id, peer, 'owner', host)).toBeNull();
    store.setMaintenance(device.id, true, 'owner', host);
    const claim = store.maintenanceClaim(device.id, peer, 'owner', host);
    store.close();
    store = new DeviceStore(directory);
    expect(store.maintenanceClaim(device.id, peer, 'owner', host)).toEqual(claim);
    store.revokeAll();
    expect(store.maintenanceClaim(device.id, peer, 'owner', host)).toBeNull();
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
