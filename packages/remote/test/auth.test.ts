import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createServiceAuth } from '../src/auth.js';
import { ServiceStore } from '../src/store.js';
import type { RemoteConfig } from '../src/config.js';
import { createOTP } from '@better-auth/utils/otp';
import { base32 } from '@better-auth/utils/base32';

describe('service login is separate from host authority', () => {
  it('requires verified email and uses Secure host-only cookies; optional MFA gates recovered/social sessions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-auth-'));
    const config: RemoteConfig = {
      home,
      service: 'https://relay.example.test',
      app: 'https://app.example.test',
      secret: 'test-secret-that-is-long-enough-for-authentication',
      smtp: 'smtp://localhost:2525',
      from: 'puddle@example.test',
      address: '127.0.0.1',
      port: 0,
      signupEmails: ['owner@example.test'],
      openSignup: false,
    };
    const store = new ServiceStore(home);
    const emails: string[] = [];
    try {
      const auth = await createServiceAuth(config, store, async (_to, _subject, url) => {
        emails.push(url);
      });
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
      const signup = await call('/sign-up/email', {
        email: 'owner@example.test',
        name: 'Owner',
        password: 'safe-test-password-123',
      });
      expect(signup.status).toBe(200);
      expect(emails.length).toBe(1);
      const unverified = await call('/sign-in/email', {
        email: 'owner@example.test',
        password: 'safe-test-password-123',
      });
      expect(unverified.status).toBe(403);
      const verification = await auth.handle(new Request(emails[0]!));
      expect(verification.status).toBeLessThan(400);
      const login = await call('/sign-in/email', {
        email: 'owner@example.test',
        password: 'safe-test-password-123',
      });
      expect(login.status).toBe(200);
      const cookies = login.headers.getSetCookie();
      expect(cookies.some((value) => value.startsWith('__Host-puddle.session_token='))).toBe(true);
      for (const cookie of cookies) {
        expect(cookie).toContain('Secure');
        expect(cookie).toContain('HttpOnly');
        expect(cookie).not.toContain('Domain=');
      }
      let cookie = cookies.map((value) => value.split(';')[0]).join('; ');
      let headers = new Headers({ cookie });
      const session = await auth.authorised(headers);
      expect(session?.user.email).toBe('owner@example.test');
      expect(store.list(session!.user.id)).toEqual([]);
      const enabled = await call(
        '/two-factor/enable',
        { password: 'safe-test-password-123' },
        cookie,
      );
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
      // A fresh social/recovered session carries no Puddle MFA confirmation.
      store.clearMfa(session!.user.id);
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
      await call('/sign-out', {}, cookie);
      expect(await auth.authorised(headers)).toBeNull();
    } finally {
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
