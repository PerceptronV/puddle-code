import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REMOTE_POLICY } from '@puddle/shared';
import { DeviceStore } from '../src/devices.js';
import { Participation } from '../src/participation.js';
import { permittedRequest, permittedTerminal } from '../src/policy.js';

const peer = '12D3KooW' + 'a'.repeat(44);
describe('host device authority', () => {
  it('consumes invitations atomically, binds approval to the peer, persists revocation and enforces grant expiry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'puddle-device-'));
    let now = 1000;
    let store = new DeviceStore(directory, () => now);
    try {
      const invitation = store.invite();
      const device = store.enrol(invitation.invitation, peer, 'owner', 'Phone');
      expect(store.valid(device.id, peer, 'owner')).toBe(false);
      expect(() => store.enrol(invitation.invitation, peer, 'owner', 'Again')).toThrow();
      store.approve(device.id);
      expect(store.valid(device.id, peer, 'owner')).toBe(true);
      expect(store.valid(device.id, peer + 'x', 'owner')).toBe(false);
      expect(store.valid(device.id, peer, 'someone-else')).toBe(false);
      now += REMOTE_POLICY.idleMs;
      expect(store.valid(device.id, peer, 'owner')).toBe(false);
      store.revoke(device.id);
      store.close();
      store = new DeviceStore(directory, () => now);
      expect(store.valid(device.id, peer, 'owner')).toBe(false);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('does not accept expired, replayed or stockpiled participation', () => {
    let now = 0;
    const participation = new Participation(() => now);
    const nonce = participation.challenge()!;
    expect(participation.challenge()).toBeNull();
    now = 14_999;
    expect(participation.accept(nonce)).toBe(0);
    expect(participation.accept(nonce)).toBeNull();
    now = 45_000;
    expect(participation.valid()).toBe(false);
    expect(participation.challenge()).toBeNull();
  });
});
describe('remote surface', () => {
  const id = crypto.randomUUID();
  const request = (method: 'GET' | 'POST' | 'PATCH', path: string) =>
    permittedRequest({ t: 'request', id, method, path });
  it('allows text review and placement terminals', () => {
    expect(request('GET', `/api/worktrees/${id}/file?path=README.md`).path).toContain('README.md');
    expect(permittedTerminal({ t: 'stdin', session: id, term: 'agent', data: 'hello' }).t).toBe(
      'stdin',
    );
  });
  it.each([
    '/proxy/a/3000',
    '/cockpit/refresh',
    '/agent-signal',
    '/api/config/../accounts',
    '/api/%73essions',
    '/api/sessions#fragment',
    '//evil.test/api/sessions',
    '/api/sessions?x=y',
    '/api/sessions?project=a&project=b',
    `/api/worktrees/${crypto.randomUUID()}/media?path=index.html`,
  ])('denies %s', (path) => {
    expect(() => request('GET', path)).toThrow();
  });
  it('denies writes and credential substitution', () => {
    expect(() => request('POST', `/api/worktrees/${id}/git-push`)).toThrow();
    expect(() => permittedTerminal({ t: 'auth', token: 'attacker' })).toThrow();
    expect(() =>
      permittedTerminal({ t: 'attach', session: 'home', term: 'agent', rows: 20, cols: 80 }),
    ).toThrow();
  });
});
