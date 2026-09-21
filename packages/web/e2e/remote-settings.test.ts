import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { fixture, createSession } from '../../cli/e2e/helpers';
import type { CockpitRemoteRequest, CockpitRemoteStatus } from '@puddle/shared';

test('desktop registration, re-enablement, recovery and confirmed deletion', async ({
  page,
}, testInfo) => {
  const local = await fixture();
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
    let failDeletion = false;
    await page.route('**/cockpit/remote', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: state });
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
    await page.getByLabel('Relay origin', { exact: true }).fill('https://relay.example.test');
    await page.getByLabel('Application origin', { exact: true }).fill('https://app.example.test');
    const code = 'a'.repeat(64);
    await page.getByLabel('Registration code', { exact: true }).fill(code);
    await page.screenshot({ path: testInfo.outputPath('desktop-enable-remote.png') });
    await page.getByRole('button', { name: 'Enable remote access', exact: true }).click();
    await expect(page.getByText('Connected to relay', { exact: true })).toBeVisible();
    expect(requests[0]).toEqual({
      t: 'enable',
      registration: {
        service: 'https://relay.example.test',
        app: 'https://app.example.test',
        code,
      },
    });
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain(code);
    await page.getByRole('button', { name: 'Disable remote access', exact: true }).click();
    await expect(page.getByText('Disabled', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Enable remote access', exact: true }).click();
    await expect(page.getByText('Connected to relay', { exact: true })).toBeVisible();
    expect(requests.at(-1)).toEqual({ t: 'enable' });
    await page.getByText('Host identity recovery', { exact: true }).click();
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
      page.getByRole('button', { name: 'Delete registration…', exact: true }),
    ).toHaveCount(0);
    state.canDeleteRegistration = true;
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await page.getByRole('button', { name: 'Enable remote access', exact: true }).click();
    await expect(page.getByText('Connected to relay', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Delete registration…', exact: true }).click();
    const confirmation = page.getByRole('dialog', {
      name: 'Delete this host’s remote registration?',
    });
    await expect(confirmation).toContainText('Agents keep running');
    await page.screenshot({ path: testInfo.outputPath('desktop-delete-registration.png') });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(requests.some((request) => request.t === 'delete_registration')).toBe(false);
    await page.getByRole('button', { name: 'Delete registration…', exact: true }).click();
    failDeletion = true;
    await page.getByRole('button', { name: 'Delete registration', exact: true }).click();
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole('alert')).toContainText('Host unavailable');
    await expect(
      page.getByRole('button', { name: 'Delete registration', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Delete registration', exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(page.getByText('Not configured', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Relay origin', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Application origin', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Registration code', { exact: true })).toHaveValue('');
    await expect(
      page.getByRole('button', { name: 'Delete registration…', exact: true }),
    ).toHaveCount(0);
  } finally {
    await page.context().close();
    await local.close();
    rmSync(local.home, { recursive: true, force: true });
  }
});
