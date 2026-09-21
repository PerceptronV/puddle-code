import { test, expect } from '@playwright/test';
import { mobileFixture } from './mobile-fixture';
import { websocket, until } from '../../cli/e2e/helpers';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectSchema } from '@puddle/shared';
import { checkTerminalScrolling, expectStationaryPage, swipe } from './mobile-scrolling';
import { checkImagePicker } from './mobile-image-paste';

test.use({ hasTouch: true, isMobile: true });

test('pairs a real browser, sends Unicode exactly once, preserves drafts and revokes a live viewer', async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  page.setDefaultTimeout(15_000);
  const fixture = await mobileFixture();
  const projects = projectSchema
    .array()
    .parse(await (await fixture.local.req('/api/projects')).json());
  const originalProject = projects.find((project) => project.id === fixture.session.project_id)!;
  const secondProject = projectSchema.parse(
    await (
      await fixture.local.req('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Second project',
          profile_id: originalProject.profile_id,
          repo_id: originalProject.repo_id,
        }),
      })
    ).json(),
  );
  await fixture.local.req('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      project_id: secondProject.id,
      kind: 'terminal',
      title: 'Other project terminal',
      separate_branch: false,
    }),
  });
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
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    const cookie = (await page.context().cookies(fixture.serviceOrigin))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
    const account = await fixture.remote.auth.authorised(new Headers({ cookie }));
    expect(account).not.toBeNull();
    await fixture.enable(account!.user.id);
    fixture.remote.store.redeem(
      fixture.remote.store.register(account!.user.id, 'Offline host').code,
    );
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
    const qr = desktop.getByRole('img', { name: 'Pairing invitation QR code' });
    await expect(qr).toBeVisible();
    expect(await qr.evaluate((element) => element.tagName)).toBe('svg');
    let scanInk = '';
    for (const theme of ['light', 'dark']) {
      await desktop.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      const normalInk = await desktop
        .locator('body')
        .evaluate((element) => getComputedStyle(element).color);
      await expect(invitation).toHaveCSS('color', normalInk);
      await expect(qr).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      const appearance = await qr.evaluate((element) => ({
        colour: getComputedStyle(element).color,
        radius: parseFloat(getComputedStyle(element).borderRadius),
      }));
      if (theme === 'light') scanInk = normalInk;
      expect(appearance.colour).toBe(scanInk);
      expect(appearance.radius).toBeGreaterThan(0);
      await desktop.getByRole('region', { name: 'Pairing invitation' }).screenshot({
        path: testInfo.outputPath(`pairing-${theme}.png`),
      });
    }
    await desktop.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    await page.goto((await invitation.getAttribute('href'))!);
    await expect(
      page.getByRole('heading', { name: 'Pair this browser', exact: true }),
    ).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    await page.screenshot({ path: testInfo.outputPath('phone-pairing.png') });
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
    await page.getByRole('button', { name: 'Open fixture', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Expand sessions' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Session', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Open session / })).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: 'Open session Other project terminal', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Compose prompt' }).click();
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
    await page.locator('.phone-terminal:not([hidden]) .xterm-screen').tap();
    await page.keyboard.type('Direct input');
    await page.keyboard.press('Enter');
    const typed = await websocket(fixture.local.origin, fixture.local.credential);
    typed.send({ t: 'attach', session: fixture.session.id, term: 'agent', cols: 80, rows: 24 });
    await until(
      () =>
        typed.messages.some(
          (message) => message.t === 'replay' && message.data.includes('INPUT:Direct input'),
        ),
      Boolean,
    );
    typed.close();
    await checkTerminalScrolling(page, fixture);
    await checkImagePicker(page, fixture);
    await page.getByRole('button', { name: 'Ctrl', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Ctrl', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.keyboard.press('u');
    await expect(page.getByRole('button', { name: 'Ctrl', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Unsent draft');
    const terminal = await page.locator('.phone-terminal:not([hidden]) .xterm').elementHandle();
    await page.getByRole('button', { name: 'Switch to Second project', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Open session Other project terminal', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /^Open session / })).toHaveCount(1);
    expect(await terminal!.evaluate((element) => element.isConnected)).toBe(true);
    await page.getByRole('button', { name: 'Switch to fixture', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(
      'Unsent draft',
    );
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(
      'Unsent draft',
    );
    await page.screenshot({ path: testInfo.outputPath('phone-workspace.png') });
    const existing = fixture.remote.store
      .list(account!.user.id)
      .find((host) => host.label === 'Fixture host')!;
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
      '<script>window.repositoryExecuted = true</script>\n' + 'File scroll content\n'.repeat(100),
    );
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: 'Review changes' }).click();
    await page.getByRole('button', { name: 'review.html · added', exact: true }).click();
    await expect(page.locator('pre')).toContainText(
      '+<script>window.repositoryExecuted = true</script>',
    );
    expect(await page.evaluate(() => 'repositoryExecuted' in window)).toBe(false);
    await page.getByRole('button', { name: 'Terminals', exact: true }).click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: 'Select file review.html', exact: true }).dblclick();
    await expect(page.locator('.phone-file-source')).toContainText(
      '<script>window.repositoryExecuted = true</script>',
    );
    expect(await page.evaluate(() => 'repositoryExecuted' in window)).toBe(false);
    const fileViewer = page.locator('.phone-file-source').locator('..');
    const topbarY = (await page.locator('.remote-topbar').boundingBox())!.y;
    await swipe(page, fileViewer, 'up');
    await expect.poll(() => fileViewer.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expectStationaryPage(page, topbarY);
    await page.getByRole('button', { name: 'Back to files', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Select file review.html', exact: true }),
    ).toBeVisible();
    await page.locator('.phone-files button[title]').click();
    await page.getByLabel('Directory path').fill(String(fixture.session.worktree_path));
    await page.getByRole('button', { name: 'Open directory', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Back to worktree' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Select file review.html', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Terminals', exact: true }).click();
    await page.getByRole('button', { name: 'Expand sessions' }).click();
    await expect(page.getByRole('button', { name: 'Collapse sessions' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('phone-expanded-sessions.png') });
    await page.getByRole('button', { name: 'Collapse sessions' }).click();
    const railSession = page.getByRole('button', { name: /^Open session / }).first();
    await railSession.dispatchEvent('pointerdown', { button: 0, clientX: 20, clientY: 20 });
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.locator('.phone-session-button').first().dispatchEvent('pointerup');
    await expect(page.getByRole('button', { name: 'Archive session', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'New terminal', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'New terminal', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open terminal', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Open session / })).toHaveCount(2);
    await page.getByRole('button', { name: 'Session details' }).click();
    await page.getByRole('button', { name: 'Archive session', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Open session / })).toHaveCount(1);
    await page.getByRole('button', { name: 'Archived sessions', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Archived sessions' })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('phone-session-rail.png') });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('region', { name: 'Host connections' })
      .getByText('Fixture host', { exact: true })
      .locator('..')
      .locator('..')
      .getByRole('button', { name: 'Disconnect', exact: true })
      .click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open fixture', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Offline host' })).toBeVisible();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open fixture', exact: true })).toBeVisible();
    for (const theme of ['light', 'dark']) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('combobox', { name: 'Appearance', exact: true }).click();
      await page
        .getByRole('option', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true })
        .click();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.screenshot({
        path: testInfo.outputPath(`phone-projects-${theme}.png`),
        animations: 'disabled',
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await page.getByRole('button', { name: 'Open fixture', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(
      'Unsent draft',
    );
    await expect(page.getByRole('button', { name: 'Insert image' })).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath('phone-terminal-dark.png'),
      animations: 'disabled',
    });
    await desktop.screenshot({ path: testInfo.outputPath('desktop-remote-access.png') });
    await desktop.getByRole('button', { name: 'Revoke Test phone', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Pairing required or access revoked', {
      timeout: 20_000,
    });
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Insert image' })).toBeDisabled();
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
