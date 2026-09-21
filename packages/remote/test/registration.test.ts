import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { digest, secret } from '@puddle/shared/node';
import { ServiceStore } from '../src/store.js';

describe('desktop registration proof', () => {
  it('requires the private verifier, redeems once, and retains replay protection after host removal', () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-registration-'));
    const store = new ServiceStore(home);
    try {
      const code = secret();
      const request = {
        challenge: digest(code),
        label: 'Workstation',
        service: 'https://relay.example.test',
        app: 'https://app.example.test',
        expires: Date.now() + 60_000,
      };
      expect(store.registrationReady(code)).toBe(false);
      store.registerDesktop('owner', request);
      expect(store.registrationReady(code)).toBe(true);
      expect(store.registrationReady(request.challenge)).toBe(false);
      expect(() => store.redeem(request.challenge)).toThrow();
      expect(() => store.registerDesktop('other', request)).toThrow();
      expect(store.list('other')).toEqual([]);
      const credential = store.redeem(code);
      expect(credential.account).toBe('owner');
      expect(store.authenticate(credential.credential)?.label).toBe('Workstation');
      expect(store.registrationReady(code)).toBe(false);
      expect(() => store.redeem(code)).toThrow();
      store.remove(credential.host, 'owner');
      expect(() => store.registerDesktop('owner', request)).toThrow();
      expect(store.list('owner')).toEqual([]);
      expect(
        JSON.stringify(store.db.prepare('SELECT * FROM desktop_registrations').all()),
      ).not.toContain(code);
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('expires abandoned approvals, refuses long-lived requests and upgrades existing state without losing hosts', () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-registration-upgrade-'));
    let store = new ServiceStore(home);
    try {
      const existing = store.redeem(store.register('owner', 'Existing').code);
      store.db.exec('DROP TABLE desktop_registrations; PRAGMA user_version = 1;');
      store.close();
      store = new ServiceStore(home);
      expect(store.authenticate(existing.credential)?.id).toBe(existing.host);
      const code = secret();
      const request = {
        challenge: digest(code),
        label: 'Abandoned',
        service: 'https://relay.example.test',
        app: 'https://app.example.test',
        expires: Date.now() + 60_000,
      };
      expect(() =>
        store.registerDesktop('owner', { ...request, expires: Date.now() - 1 }),
      ).toThrow();
      expect(() =>
        store.registerDesktop('owner', { ...request, expires: Date.now() + 600_000 }),
      ).toThrow();
      store.registerDesktop('owner', request);
      store.db.prepare('UPDATE desktop_registrations SET expires = ?').run(Date.now() - 1);
      expect(store.registrationReady(code)).toBe(false);
      expect(() => store.redeem(code)).toThrow();
      store.prune();
      expect(store.list('owner').map((host) => host.id)).toEqual([existing.host]);
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
