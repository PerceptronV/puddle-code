import { test, expect } from '@playwright/test';
import { mobileFixture } from './mobile-fixture';
import { websocket, until } from '../../cli/e2e/helpers';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

test('pairs a real browser, sends Unicode exactly once, preserves drafts and revokes a live viewer', async ({
  page,
}, testInfo) => {
  const fixture = await mobileFixture();
  const errors: string[] = [];
  const ciphertext: Buffer[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('websocket', (socket) =>
    socket.on('framesent', ({ payload }) => {
      if (Buffer.isBuffer(payload)) ciphertext.push(payload);
    }),
  );
  try {
    await page.goto(fixture.appOrigin + '/');
    await expect(page.getByLabel('Email', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Forgot password' })).toHaveCount(0);
    await page.route('https://github.com/login/oauth/authorize?**', async (route) => {
      await route.fulfill({
        status: 302,
        headers: {
          location: fixture.github.callback(route.request().url(), { email: 'owner@example.test' }),
        },
      });
    });
    await page.getByRole('button', { name: 'Continue with GitHub', exact: true }).click();
    await expect(page.getByText('Your hosts')).toBeVisible();
    const cookie = (await page.context().cookies(fixture.serviceOrigin))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
    const account = await fixture.remote.auth.authorised(new Headers({ cookie }));
    expect(account).not.toBeNull();
    await fixture.enable(account!.user.id);
    const desktop = await page.context().newPage();
    await desktop.setViewportSize({ width: 1200, height: 850 });
    const profiles = await (await fixture.local.req('/api/profiles')).json();
    await desktop.addInitScript(
      ({ origin, credential, profile }) => {
        if (location.origin === origin) {
          localStorage.setItem('puddle.browser-authorisation', credential);
          localStorage.setItem('puddle.profile-id', profile);
        }
      },
      {
        origin: fixture.local.origin,
        credential: fixture.local.credential,
        profile: profiles[0].id,
      },
    );
    await desktop.goto(fixture.local.origin + '/#settings/remote');
    await expect(desktop.getByText('Connected to relay', { exact: true })).toBeVisible();
    await desktop.getByRole('button', { name: 'Pair a browser', exact: true }).click();
    const invitation = desktop.getByRole('link', { name: 'Open pairing link' });
    await expect(invitation).toBeVisible();
    await page.goto((await invitation.getAttribute('href'))!);
    await expect(page.getByText('Pair this browser')).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    await page.getByLabel('Browser name').fill('Test phone');
    await page.getByRole('button', { name: 'Request host approval' }).click();
    await expect(page.getByRole('status')).toContainText('Waiting for host approval');
    const devices = await fixture.admin({ t: 'devices' });
    const device = devices.devices!.find((device) => device.status === 'pending')!;
    await expect(page.getByText(device.peer, { exact: true })).toBeVisible();
    await desktop.getByRole('button', { name: 'Refresh status' }).click();
    await expect(desktop.getByText(device.peer, { exact: true })).toBeVisible();
    await desktop.getByRole('button', { name: 'Approve this identity' }).click();
    await expect(page.getByRole('status')).toHaveText('Connected');
    await page
      .getByRole('combobox', { name: 'Project', exact: true })
      .selectOption(String(fixture.session.project_id));
    await page
      .getByRole('combobox', { name: 'Session', exact: true })
      .selectOption(String(fixture.session.id));
    await expect(page.getByRole('button', { name: 'Ctrl-C' })).toBeEnabled();
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Hello 日本語 🌊');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('');
    const viewer = await websocket(fixture.local.origin, fixture.local.credential);
    viewer.send({ t: 'attach', session: fixture.session.id, term: 'agent', cols: 80, rows: 24 });
    await until(
      () =>
        viewer.messages.some(
          (message) => message.t === 'replay' && message.data.includes('INPUT:Hello 日本語 🌊'),
        ),
      Boolean,
    );
    viewer.close();
    expect(Buffer.concat(ciphertext).includes(Buffer.from('Hello 日本語 🌊'))).toBe(false);
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Unsent draft');
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(
      'Unsent draft',
    );
    await page.screenshot({ path: testInfo.outputPath('phone-workspace.png') });
    const existing = fixture.remote.store.list(account!.user.id)[0]!;
    fixture.remote.relay.remove(existing.id);
    await expect(page.getByRole('status')).not.toHaveText('Connected');
    await expect(page.getByRole('status')).toHaveText('Connected', { timeout: 20_000 });
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(
      'Unsent draft',
    );
    const restored = await websocket(fixture.local.origin, fixture.local.credential);
    restored.send({ t: 'attach', session: fixture.session.id, term: 'agent', cols: 80, rows: 24 });
    await until(() => restored.messages.some((message) => message.t === 'replay'), Boolean);
    const replay = restored.messages.find((message) => message.t === 'replay');
    expect(replay && 'data' in replay && replay.data.match(/INPUT:Hello 日本語 🌊/g)).toHaveLength(
      1,
    );
    restored.close();
    writeFileSync(
      join(String(fixture.session.worktree_path), 'review.html'),
      '<script>window.repositoryExecuted = true</script>\n',
    );
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await page.getByRole('button', { name: 'review.html · added', exact: true }).click();
    await expect(page.locator('pre')).toContainText(
      '+<script>window.repositoryExecuted = true</script>',
    );
    expect(await page.evaluate(() => 'repositoryExecuted' in window)).toBe(false);
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await desktop.screenshot({ path: testInfo.outputPath('desktop-remote-access.png') });
    await desktop.getByRole('button', { name: 'Revoke Test phone', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Pairing required or access revoked', {
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    expect(errors).toEqual([]);
    const alive = await fixture.local.req(`/api/sessions/${fixture.session.id}`);
    expect(alive.status).toBe(200);
    await expect(desktop.getByText('Revoked', { exact: true })).toBeVisible();
    await desktop.getByRole('button', { name: 'Disable remote access', exact: true }).click();
    await expect(desktop.getByText('Disabled', { exact: true })).toBeVisible();
    expect((await fixture.admin({ t: 'status' })).enabled).toBe(false);
    await desktop.getByRole('button', { name: 'Delete registration…', exact: true }).click();
    await desktop.getByRole('button', { name: 'Delete registration', exact: true }).click();
    await expect(desktop.getByText('Not configured', { exact: true })).toBeVisible();
    expect(existsSync(join(fixture.local.home, 'remote/config.json'))).toBe(false);
    expect((await fixture.local.req(`/api/sessions/${fixture.session.id}`)).status).toBe(200);
  } finally {
    await page.context().close();
    await fixture.close();
  }
});
