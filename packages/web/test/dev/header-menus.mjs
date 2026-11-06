/* global document, Event, getComputedStyle */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const host = page.getByTitle('All projects', { exact: true });
  const route = page.url();
  await host.click({ button: 'right' });
  assert.equal(page.url(), route, 'right-click does not navigate');
  await page.getByRole('menuitem', { name: 'Rename host', exact: true }).click();
  const hostName = page.locator('header .host-identity input');
  await hostName.fill('Preview host');
  await hostName.press('Enter');
  await host.getByText('Preview host', { exact: true }).waitFor();
  await host.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Change host colour', exact: true }).click();
  const accents = page.getByRole('group', { name: 'Host accent', exact: true });
  await accents.getByRole('button', { name: 'blue', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.hostColour === 'blue');
  assert.equal(
    await accents
      .getByRole('button', { name: 'Default colour', exact: true })
      .locator('span')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    'rgb(107, 107, 107)',
  );
  assert.ok(
    await accents.getByRole('button', { name: 'Custom host accent', exact: true }).isVisible(),
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await host.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Host updates', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor();
  assert.ok(page.url().endsWith('#settings/host'));
  assert.equal(
    await page.getByRole('button', { name: 'Host', exact: true }).getAttribute('aria-current'),
    'page',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  const profile = page.locator('header .profile-trigger');
  await profile.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename profile', exact: true }).click();
  const profileName = page.locator('header .profile-trigger input');
  await profileName.fill('Preview profile');
  await profileName.press('Enter');
  await profile.getByText('Preview profile', { exact: true }).waitFor();
  await profile.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Change profile colour', exact: true }).click();
  const colours = page.getByRole('group', { name: 'Profile colour', exact: true });
  assert.ok(await colours.getByRole('button', { name: 'green', exact: true }).isVisible());
  await colours.locator('input[type="color"]').evaluate((input) => {
    input.value = '#12a6bc';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('header .profile-trigger span')).color ===
      'rgb(18, 166, 188)',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await profile.click();
  await page.getByRole('button', { name: 'Switch profile', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'Header context menus rename host/profile, preserve presets/custom colours, open Host settings and retain normal profile clicks.',
  );
} finally {
  await browser.close();
}
