import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { fixture, createSession } from '../../cli/e2e/helpers';
import type {
  CockpitRemoteRequest,
  CockpitRemoteStatus,
  DesktopRegistration,
} from '@puddle/shared';
import { createHash } from 'node:crypto';

test('desktop registration, re-enablement, recovery and confirmed deletion', async ({
  page,
}, testInfo) => {
  const local = await fixture();
  let finishRead: (() => void) | undefined;
  let finishCheck: (() => void) | undefined;
  try {
    await createSession(local);
    const profiles = await (await local.req('/api/profiles')).json();
    await page.addInitScript(
      ({ credential, profile }) => {
        localStorage.setItem('puddle.browser-authorisation', credential);
        localStorage.setItem('puddle.profile-id', profile);
      },
      { credential: local.credential, profile: profiles[0].id },
    );
    // The supervisor belongs to the operator. This UI-only fixture never installs
    // launchd/systemd units; separate host-control tests exercise command dispatch.
    const state: CockpitRemoteStatus = {
      availability: 'ready',
      configured: false,
      enabled: false,
      connected: false,
      canDeleteRegistration: true,
      supervisor: 'launchd',
      devices: [],
    };
    const requests: CockpitRemoteRequest[] = [];
    let signInReady = false;
    let verifier = '';
    let holdCheck = false;
    let checkHeld = false;
    await page.route('**/cockpit/remote/registration', async (route) => {
      verifier = route.request().postDataJSON().code;
      if (holdCheck) {
        holdCheck = false;
        checkHeld = true;
        await new Promise<void>((resolve) => {
          finishCheck = resolve;
        });
        return route.fulfill({ json: { ready: true } });
      }
      await route.fulfill({ json: { ready: signInReady } });
    });
    // Avoid external navigation: the full HTTPS fixture covers browser sign-in.
    await page.addInitScript(() => {
      const record = (event: string) => {
        document.documentElement.dataset.registrationEvents =
          (document.documentElement.dataset.registrationEvents ?? '') + event + ',';
      };
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = (...args) => {
        record('hash');
        return digest(...args);
      };
      window.open = (url) => {
        record('open');
        document.documentElement.dataset.registrationUrl = String(url);
        return null;
      };
    });
    let failDeletion = false;
    let holdRead = false;
    let readHeld = false;
    await page.route('**/cockpit/remote', async (route) => {
      if (route.request().method() === 'GET') {
        if (holdRead) {
          holdRead = false;
          readHeld = true;
          await new Promise<void>((resolve) => {
            finishRead = resolve;
          });
        }
        return route.fulfill({ json: state });
      }
      const request = route.request().postDataJSON() as CockpitRemoteRequest;
      requests.push(request);
      if (request.t === 'delete_registration' && failDeletion) {
        failDeletion = false;
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'remote_control_unavailable',
              message: 'Host unavailable. Refresh status before retrying.',
            },
          },
        });
      }
      if (request.t === 'enable') {
        state.configured = true;
        state.enabled = state.connected = true;
        state.service = request.registration?.service ?? state.service;
        state.app = request.registration?.app ?? state.app;
        state.host = '11111111-1111-4111-8111-111111111111';
      } else if (request.t === 'disable' || request.t === 'reset') {
        state.enabled = state.connected = false;
      } else if (request.t === 'delete_registration') {
        state.configured = state.enabled = state.connected = false;
        state.devices = [];
        delete state.host;
        delete state.service;
        delete state.app;
      } else throw new Error('Unexpected fixture operation');
      await route.fulfill({ json: { enabled: state.enabled, connected: state.connected } });
    });
    await page.setViewportSize({ width: 1200, height: 850 });
    await page.goto(local.origin + '/#settings/remote');
    await expect(page.getByText('Not configured', { exact: true })).toBeVisible();
    const navigation = page
      .getByRole('dialog', { name: 'Settings', exact: true })
      .getByRole('navigation');
    await expect(
      navigation.getByRole('button', { name: 'Remote & Sync', exact: true }),
    ).toBeVisible();
    await expect(
      navigation.getByRole('button', { name: 'Remote access', exact: true }),
    ).toHaveCount(0);
    await expect(navigation.getByRole('button', { name: 'Sync', exact: true })).toHaveCount(0);
    // Both former deep links and the canonical sidebar entry open the same combined section.
    await page.evaluate(() => {
      location.hash = '#settings/sync';
    });
    await expect(page.getByRole('heading', { name: 'Sync', exact: true })).toBeAttached();
    await expect(page.getByRole('heading', { name: 'Remote access', exact: true })).toBeVisible();
    await navigation.getByRole('button', { name: 'Remote & Sync', exact: true }).click();
    await expect(page).toHaveURL(/#settings\/remote-sync$/);
    await expect(page.getByLabel('Relay origin', { exact: true })).toHaveValue(
      'https://charles.waddlelabs.ai',
    );
    await expect(page.getByLabel('Application origin', { exact: true })).toHaveValue(
      'https://puddle.waddlelabs.ai',
    );
    await page.getByLabel('Relay origin', { exact: true }).fill('https://relay.example.test');
    await page.getByLabel('Application origin', { exact: true }).fill('https://app.example.test');
    holdRead = true;
    await expect.poll(() => readHeld, { timeout: 10_000 }).toBe(true);
    await expect(page.getByLabel('Application origin', { exact: true })).toBeFocused();
    await expect(page.getByLabel('Application origin', { exact: true })).toHaveValue(
      'https://app.example.test',
    );
    await expect(
      page.getByRole('button', { name: 'Sign in and enable', exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Refresh status', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Enabling…', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('desktop-enable-remote.png') });
    await page.evaluate(() => {
      document.documentElement.dataset.registrationEvents = '';
    });
    await page.getByRole('button', { name: 'Sign in and enable', exact: true }).click();
    const link = page.getByRole('link', { name: 'Continue in browser' });
    // Opening is synchronous on the UI client; no hashing or host operation intervenes.
    expect(await page.evaluate(() => document.documentElement.dataset.registrationEvents)).toBe(
      'open,',
    );
    expect(await page.evaluate(() => document.documentElement.dataset.registrationUrl)).toBe(
      await link.getAttribute('href'),
    );
    const handoff = JSON.parse(
      new URLSearchParams(new URL((await link.getAttribute('href'))!).hash.slice(1)).get(
        'register',
      )!,
    ) as DesktopRegistration;
    await expect.poll(() => verifier).toMatch(/^[a-f0-9]{64}$/);
    expect(handoff.challenge).toBe(createHash('sha256').update(verifier).digest('hex'));
    expect(await link.getAttribute('href')).not.toContain(verifier);
    // Cancelling discards the verifier, so a late browser approval cannot enable the host.
    holdCheck = true;
    await expect.poll(() => checkHeld).toBe(true);
    await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
    finishCheck!();
    const abandoned = verifier;
    await page.getByRole('button', { name: 'Sign in and enable', exact: true }).click();
    await expect.poll(() => verifier).not.toBe(abandoned);
    signInReady = true;
    await expect(page.getByRole('button', { name: 'Enabling…', exact: true })).toBeVisible();
    expect(requests).toHaveLength(0); // Explicit mutations wait for the background read to finish.
    finishRead!();
    await expect(page.getByText('Connected to relay', { exact: true })).toBeVisible();
    const actions = page.getByRole('group', { name: 'Registration actions' });
    await expect(actions.getByRole('button')).toHaveText([
      'Pair a browser',
      'Disable remote access',
      'Delete registration',
    ]);
    const positions = await actions
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().y));
    expect(new Set(positions).size).toBe(1);
    expect(requests[0]).toEqual({
      t: 'enable',
      registration: {
        service: 'https://relay.example.test',
        app: 'https://app.example.test',
        code: verifier,
      },
    });
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain(verifier);
    await page.getByRole('button', { name: 'Disable remote access', exact: true }).click();
    await expect(page.getByText('Disabled', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Change registration', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Enable remote access', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign in and enable', exact: true })).toHaveCount(
      1,
    );
    await expect(page.getByLabel('Relay origin', { exact: true })).toHaveValue(
      'https://relay.example.test',
    );
    await page.getByLabel('Relay origin', { exact: true }).fill('https://replacement.example.test');
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await expect(page.getByLabel('Relay origin', { exact: true })).toHaveValue(
      'https://replacement.example.test',
    );
    await page.screenshot({ path: testInfo.outputPath('desktop-edit-registration.png') });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByLabel('Relay origin', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Enable remote access', exact: true }).click();
    await expect(page.getByText('Connected to relay', { exact: true })).toBeVisible();
    expect(requests.at(-1)).toEqual({ t: 'enable' });
    const recovery = page.locator('summary').filter({ hasText: 'Host identity recovery' });
    await expect(recovery).toHaveCSS('list-style-type', 'none');
    await expect(recovery.locator('svg')).toHaveCSS('rotate', 'none');
    await recovery.focus();
    await page.keyboard.press('Enter');
    await expect(recovery.locator('svg')).toHaveCSS('rotate', '90deg');
    await page.getByRole('button', { name: 'Reset host identity…', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(requests.some((request) => request.t === 'reset')).toBe(false);
    await page.getByRole('button', { name: 'Reset host identity…', exact: true }).click();
    await page.getByRole('button', { name: 'Reset host identity', exact: true }).click();
    await expect(page.getByText('Disabled', { exact: true })).toBeVisible();
    expect(requests.filter((request) => request.t === 'reset')).toHaveLength(1);
    state.canDeleteRegistration = false;
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Delete registration', exact: true }),
    ).toHaveCount(0);
    state.canDeleteRegistration = true;
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await page.getByRole('button', { name: 'Enable remote access', exact: true }).click();
    await expect(page.getByText('Connected to relay', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Delete registration', exact: true }).click();
    const confirmation = page.getByRole('dialog', {
      name: 'Delete this host’s remote registration?',
    });
    await expect(confirmation).toContainText('Agents keep running');
    await page.screenshot({ path: testInfo.outputPath('desktop-delete-registration.png') });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(requests.some((request) => request.t === 'delete_registration')).toBe(false);
    await page.getByRole('button', { name: 'Delete registration', exact: true }).click();
    failDeletion = true;
    await confirmation.getByRole('button', { name: 'Delete registration', exact: true }).click();
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole('alert')).toContainText('Host unavailable');
    await expect(
      confirmation.getByRole('button', { name: 'Delete registration', exact: true }),
    ).toBeEnabled();
    await confirmation.getByRole('button', { name: 'Delete registration', exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(page.getByText('Not configured', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Relay origin', { exact: true })).toHaveValue(
      'https://charles.waddlelabs.ai',
    );
    await expect(page.getByLabel('Application origin', { exact: true })).toHaveValue(
      'https://puddle.waddlelabs.ai',
    );
    await expect(page.getByLabel('Registration code', { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Delete registration', exact: true }),
    ).toHaveCount(0);
  } finally {
    finishCheck?.();
    finishRead?.();
    await page.context().close();
    await local.close();
    rmSync(local.home, { recursive: true, force: true });
  }
});
