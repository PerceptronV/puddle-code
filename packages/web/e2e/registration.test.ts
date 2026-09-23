import { test, expect } from '@playwright/test';
import { mobileFixture } from './mobile-fixture';
import { cockpitRemoteRequestSchema, desktopRegistrationSchema } from '@puddle/shared';
import { createHash } from 'node:crypto';

test('desktop sign-in survives OAuth and enables through a private one-use verifier', async ({
  page,
}, testInfo) => {
  const fixture = await mobileFixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let verifier = '';
  try {
    await page.context().route('https://github.com/login/oauth/authorize?**', async (route) => {
      await route.fulfill({
        status: 302,
        headers: {
          location: fixture.github.callback(route.request().url(), { email: 'owner@example.test' }),
        },
      });
    });
    const profiles = await (await fixture.local.req('/api/profiles')).json();
    await page.addInitScript(
      ({ origin, credential, profile }) => {
        if (location.origin !== origin) return;
        localStorage.setItem('puddle.browser-authorisation', credential);
        localStorage.setItem('puddle.profile-id', profile);
      },
      {
        origin: fixture.local.origin,
        credential: fixture.local.credential,
        profile: profiles[0].id,
      },
    );
    // Only process supervision is substituted: use the real connector's --configure,
    // HTTPS redemption and runtime, but never install an OS service from this fixture.
    await page.route('**/cockpit/remote?profile=*', async (route) => {
      if (route.request().method() === 'GET') {
        const response = await route.fetch();
        return route.fulfill({ json: { ...(await response.json()), supervisor: 'launchd' } });
      }
      const request = cockpitRemoteRequestSchema.parse(route.request().postDataJSON());
      if (request.t !== 'enable' || !request.registration) return route.continue();
      verifier = request.registration.code;
      await fixture.enable('', verifier);
      return route.fulfill({ json: { enabled: true, connected: true } });
    });
    await page.setViewportSize({ width: 1200, height: 850 });
    await page.goto(fixture.local.origin + '/#settings/remote-sync');
    await page.getByLabel('Application origin', { exact: true }).fill(fixture.appOrigin);
    await page.getByLabel('Relay origin', { exact: true }).fill(fixture.serviceOrigin);
    await page.getByLabel('Host name', { exact: true }).fill('Fixture workstation');
    const popup = page.context().waitForEvent('page');
    await page.getByRole('button', { name: 'Sign in and enable', exact: true }).click();
    const browser = await popup;
    browser.on('pageerror', (error) => errors.push(error.message));
    const link = await page.getByRole('link', { name: 'Continue in browser' }).getAttribute('href');
    const handoff = desktopRegistrationSchema.parse(
      JSON.parse(new URLSearchParams(new URL(link!).hash.slice(1)).get('register')!),
    );
    await expect(
      browser.getByRole('button', { name: 'Continue with GitHub', exact: true }),
    ).toBeVisible();
    expect(new URL(browser.url()).hash).toBe('');
    expect(fixture.remote.store.db.prepare('SELECT * FROM remote_hosts').all()).toEqual([]);
    await browser.getByRole('button', { name: 'Continue with GitHub', exact: true }).click();
    const confirmation = browser.getByRole('dialog', { name: 'Connect Fixture workstation' });
    await expect(confirmation).toContainText('Fixture workstation');
    await expect(confirmation).toContainText(handoff.challenge.slice(0, 8).toUpperCase());
    // Authentication alone must not add the host; explicit confirmation binds the request.
    expect(fixture.remote.store.db.prepare('SELECT * FROM remote_hosts').all()).toEqual([]);
    await browser.screenshot({ path: testInfo.outputPath('browser-confirm-host.png') });
    await browser.getByRole('button', { name: 'Confirm host', exact: true }).click();
    await expect(browser.getByText('Host confirmed.', { exact: false })).toBeVisible();
    await expect(page.getByText('Connected to relay', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    expect(createHash('sha256').update(verifier).digest('hex')).toBe(handoff.challenge);
    expect(link).not.toContain(verifier);
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain(verifier);
    expect(
      await browser.evaluate(() => sessionStorage.getItem('puddle.pending-registration')),
    ).toBeNull();
    expect(() => fixture.remote.store.redeem(verifier)).toThrow();
    // Account registration does not enrol or approve a browser.
    expect((await fixture.admin({ t: 'devices' })).devices).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    // Let any in-flight status read finish before disposing its request context.
    await page.unrouteAll({ behavior: 'wait' });
    await page.context().unrouteAll({ behavior: 'wait' });
    await page.context().close();
    await fixture.close();
  }
});
