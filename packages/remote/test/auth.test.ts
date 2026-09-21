import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createServiceAuth } from '../src/auth.js';
import { ServiceStore } from '../src/store.js';
import type { RemoteConfig } from '../src/config.js';
import { createOTP } from '@better-auth/utils/otp';
import { base32 } from '@better-auth/utils/base32';
import { githubFixture, cookies } from './helpers/oauth.js';

describe('service login is separate from host authority', () => {
  it('requires verified provider email and Secure host-only cookies; optional MFA gates social sessions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-auth-'));
    const config: RemoteConfig = {
      home,
      service: 'https://relay.example.test',
      app: 'https://app.example.test',
      secret: 'test-secret-that-is-long-enough-for-authentication',
      github: { clientId: 'fixture-client', clientSecret: 'fixture-secret' },
      google: { clientId: 'fixture-google-client', clientSecret: 'fixture-google-secret' },
      address: '127.0.0.1',
      port: 0,
      signupEmails: ['owner@example.test'],
      openSignup: false,
    };
    const store = new ServiceStore(home);
    const github = githubFixture();
    try {
      const auth = await createServiceAuth(config, store);
      const call = (path: string, body?: unknown, cookie?: string) =>
        auth.handle(
          new Request(config.service + '/api/auth' + path, {
            method: body ? 'POST' : 'GET',
            headers: {
              origin: config.app,
              'content-type': 'application/json',
              ...(cookie ? { cookie } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
          }),
        );
      for (const path of [
        '/sign-up/email',
        '/sign-in/email',
        '/request-password-reset',
        '/reset-password',
        '/verify-email',
        '/send-verification-email',
        '/change-email',
        '/change-password',
        '/set-password',
        '/two-factor/send-otp',
        '/two-factor/verify-otp',
        '/link-social',
      ]) {
        expect((await call(path, {})).status).toBe(404);
        expect((await call(path)).status).toBe(404);
      }
      const googleStart = await call('/sign-in/social', {
        provider: 'google',
        callbackURL: config.app,
      });
      const googleURL = new URL(((await googleStart.json()) as { url: string }).url);
      expect(googleURL.origin).toBe('https://accounts.google.com');
      expect(googleURL.searchParams.get('redirect_uri')).toBe(
        config.service + '/api/auth/callback/google',
      );
      const start = await call('/sign-in/social', { provider: 'github', callbackURL: config.app });
      const startURL = ((await start.json()) as { url: string }).url;
      const forged = new URL(github.callback(startURL, { email: 'owner@example.test' }));
      forged.searchParams.set('state', 'wrong-state');
      const rejectedState = await auth.handle(
        new Request(forged, { headers: { cookie: cookies(start) } }),
      );
      expect(await auth.authorised(new Headers({ cookie: cookies(rejectedState) }))).toBeNull();
      expect(store.db.prepare('SELECT * FROM user').all()).toEqual([]);
      const denied = await github.login(auth, config, { email: 'stranger@example.test' });
      expect(denied.headers.get('location')).toContain('error=');
      expect(await auth.authorised(new Headers({ cookie: cookies(denied) }))).toBeNull();
      const unverified = await github.login(auth, config, {
        email: 'owner@example.test',
        verified: false,
      });
      expect(unverified.headers.get('location')).toContain('error=email_not_verified');
      expect(store.db.prepare('SELECT * FROM user').all()).toEqual([]);
      const login = await github.login(auth, config, { email: 'owner@example.test' });
      expect(login.status).toBe(302);
      const issuedCookies = login.headers.getSetCookie();
      expect(issuedCookies.some((value) => value.startsWith('__Host-puddle.session_token='))).toBe(
        true,
      );
      for (const cookie of issuedCookies) {
        expect(cookie).toContain('Secure');
        expect(cookie).toContain('HttpOnly');
        expect(cookie).not.toContain('Domain=');
      }
      let cookie = cookies(login);
      let headers = new Headers({ cookie });
      const session = await auth.authorised(headers);
      expect(session?.user.email).toBe('owner@example.test');
      expect(store.list(session!.user.id)).toEqual([]);
      // Neither a changed provider claim nor another identity with a matching
      // email can recover this account by bypassing the original provider binding.
      const changed = await github.login(auth, config, {
        email: 'owner@example.test',
        verified: false,
      });
      expect(changed.headers.get('location')).toContain('error=email_not_verified');
      const otherIdentity = await github.login(auth, config, {
        email: 'owner@example.test',
        id: 'different-identity',
      });
      expect(otherIdentity.headers.get('location')).toContain('error=account_not_linked');
      const enabled = await call('/two-factor/enable', {}, cookie);
      expect(enabled.status).toBe(200);
      const setup = (await enabled.json()) as { totpURI: string; backupCodes: string[] };
      const secret = new TextDecoder().decode(
        base32.decode(new URL(setup.totpURI).searchParams.get('secret')!),
      );
      const verified = await call(
        '/two-factor/verify-totp',
        { code: await createOTP(secret).totp() },
        cookie,
      );
      expect(verified.status).toBe(200);
      const replacements = verified.headers.getSetCookie();
      if (replacements.length) cookie = replacements.map((value) => value.split(';')[0]).join('; ');
      headers = new Headers({ cookie });
      const withMfa = await auth.authorised(headers);
      expect(withMfa?.user.twoFactorEnabled).toBe(true);
      // A fresh provider login carries no Puddle MFA confirmation.
      cookie = cookies(await github.login(auth, config, { email: 'owner@example.test' }));
      headers = new Headers({ cookie });
      expect(await auth.authorised(headers)).toBeNull();
      const sensitive = await call('/two-factor/disable', {}, cookie);
      expect(sensitive.status).toBe(403);
      const backup = await call(
        '/two-factor/verify-backup-code',
        { code: setup.backupCodes[0] },
        cookie,
      );
      expect(backup.status).toBe(200);
      expect((await auth.authorised(headers))?.user.id).toBe(session!.user.id);
      expect(
        (await call('/two-factor/verify-backup-code', { code: setup.backupCodes[0] }, cookie))
          .status,
      ).toBeGreaterThanOrEqual(400);
      const disabled = await call('/two-factor/disable', {}, cookie);
      expect(disabled.status).toBe(200);
      cookie = cookies(disabled);
      headers = new Headers({ cookie });
      expect((await auth.authorised(headers))?.user.twoFactorEnabled).toBe(false);
      // Mixed legacy accounts retain provider identity and hosts, but passwords
      // and all pre-upgrade sessions/challenges are retired exactly once.
      const registration = store.register(session!.user.id, 'Existing host');
      store.db
        .prepare(
          "INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, ?, ?)",
        )
        .run(
          'legacy-credential',
          session!.user.id,
          session!.user.id,
          'obsolete-password-hash',
          Date.now(),
          Date.now(),
        );
      const upgraded = await createServiceAuth(config, store);
      expect(
        store.db.prepare("SELECT * FROM account WHERE providerId = 'credential'").all(),
      ).toEqual([]);
      expect(store.db.prepare('SELECT * FROM verification').all()).toEqual([]);
      expect(await upgraded.authorised(headers)).toBeNull();
      cookie = cookies(await github.login(upgraded, config, { email: 'owner@example.test' }));
      headers = new Headers({ cookie });
      expect((await upgraded.authorised(headers))?.user.id).toBe(session!.user.id);
      expect(store.host(registration.host)?.account).toBe(session!.user.id);
      const restarted = await createServiceAuth(config, store);
      expect((await restarted.authorised(headers))?.user.id).toBe(session!.user.id);
      await call('/sign-out', {}, cookie);
      expect(await auth.authorised(headers)).toBeNull();
    } finally {
      github.close();
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('consumes service registration once and isolates account host inventories', () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-service-'));
    const store = new ServiceStore(home);
    try {
      const registration = store.register('owner', 'Workstation');
      const connector = store.redeem(registration.code);
      expect(() => store.redeem(registration.code)).toThrow();
      expect(store.authenticate(connector.credential)?.account).toBe('owner');
      expect(store.list('someone-else')).toEqual([]);
      expect(store.db.prepare('SELECT credential FROM remote_hosts').get()).not.toEqual({
        credential: connector.credential,
      });
      store.remove(connector.host, 'someone-else');
      expect(store.authenticate(connector.credential)).toBeDefined();
      store.remove(connector.host, 'owner');
      expect(store.authenticate(connector.credential)).toBeUndefined();
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
