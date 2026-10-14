import { test, expect } from '@playwright/test';
import {
  fakeCamera,
  mockPairingAccount,
  pairingLink,
  savedIdentity,
  startPairingFixture,
} from './pairing-fixture';

test.use({ hasTouch: true, isMobile: true });
let fixture: Awaited<ReturnType<typeof startPairingFixture>>;
test.beforeAll(async () => {
  fixture = await startPairingFixture();
});
test.afterAll(async () => {
  await fixture?.server.close();
});
test.beforeEach(async ({ page }) => {
  await mockPairingAccount(page);
  await page.goto(fixture.origin);
});

test('scans a real QR image in this app and saves a separate device identity only after confirmation', async ({
  page,
  browser,
}) => {
  const link = pairingLink(fixture.origin);
  expect(
    await page.evaluate(() => {
      const policy = (
        document as Document & { featurePolicy: { allowsFeature(name: string): boolean } }
      ).featurePolicy;
      return policy.allowsFeature('camera') && !policy.allowsFeature('microphone');
    }),
  ).toBe(true);
  // A Safari-like context already paired through the ordinary URL flow.
  const safari = await browser.newContext();
  try {
    const tab = await safari.newPage();
    await mockPairingAccount(tab);
    await tab.goto(link);
    await tab.getByLabel('Browser name').fill('Browser tab');
    await tab.getByRole('button', { name: 'Request host approval' }).click();
    await expect.poll(() => savedIdentity(tab)).not.toBeNull();
    const browserKey = (await savedIdentity(tab))!.privateKey;
    await fakeCamera(page, link);
    await page
      .getByRole('main', { name: 'Hosts and projects' })
      .locator('header')
      .getByRole('button', { name: 'Pair this device', exact: true })
      .tap();
    expect(await page.locator('html').getAttribute('data-camera-requests')).toBe('0');
    await page.getByRole('button', { name: 'Scan QR code' }).tap();
    const confirmation = page.getByRole('dialog', { name: 'Pair this browser' });
    await expect(confirmation).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-camera-stops', '1');
    await expect(page).toHaveURL(fixture.origin + '/');
    expect(page.context().pages()).toHaveLength(1);
    expect(await savedIdentity(page)).toBeNull();
    await confirmation.getByLabel('Browser name').fill('Home Screen app');
    await confirmation.getByRole('button', { name: 'Request host approval' }).tap();
    await expect.poll(() => savedIdentity(page)).not.toBeNull();
    const device = (await savedIdentity(page))!;
    expect(device.label).toBe('Home Screen app');
    expect(device.privateKey).not.toEqual(browserKey);
    expect(await page.evaluate(() => sessionStorage.getItem('puddle.pending-pair'))).toBeNull();
  } finally {
    await safari.close();
  }
});

test('Settings replaces host creation with pairing and handles camera denial through paste', async ({
  page,
}) => {
  await fakeCamera(page, pairingLink(fixture.origin), 'denied');
  await page.getByRole('button', { name: 'Settings', exact: true }).tap();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByText('Add a host', { exact: true })).toHaveCount(0);
  await expect(settings.getByText('Create registration code', { exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Pair this device' }).tap();
  await page.getByRole('button', { name: 'Scan QR code' }).tap();
  await expect(page.getByRole('alert')).toContainText('Camera access was blocked');
  await page.getByLabel('Or paste a pairing link').fill(pairingLink(fixture.origin));
  await page.getByRole('button', { name: 'Continue', exact: true }).tap();
  await expect(page.getByRole('dialog', { name: 'Pair this browser' })).toBeVisible();
  expect(await savedIdentity(page)).toBeNull();
});

for (const mode of ['blank', 'pending'] as const) {
  test(`closing the scanner releases a ${mode === 'blank' ? 'running' : 'late-granted'} camera`, async ({
    page,
  }) => {
    await fakeCamera(page, pairingLink(fixture.origin), mode);
    await page
      .getByRole('main', { name: 'Hosts and projects' })
      .locator('header')
      .getByRole('button', { name: 'Pair this device', exact: true })
      .tap();
    await page.getByRole('button', { name: 'Scan QR code' }).tap();
    await expect(page.locator('html')).toHaveAttribute('data-camera-requests', '1');
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).tap();
    if (mode === 'pending')
      await page.evaluate(() => document.dispatchEvent(new Event('fixture-camera-granted')));
    await expect(page.locator('html')).toHaveAttribute('data-camera-stops', '1');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await savedIdentity(page)).toBeNull();
  });
}

test('backgrounding the app stops the camera and invalid QR codes stay in the scanner', async ({
  page,
}) => {
  await fakeCamera(page, 'https://unrelated.example.test/');
  await page
    .getByRole('main', { name: 'Hosts and projects' })
    .locator('header')
    .getByRole('button', { name: 'Pair this device', exact: true })
    .tap();
  await page.getByRole('button', { name: 'Scan QR code' }).tap();
  await expect(page.getByRole('alert')).toContainText('different Puddle app');
  await expect(page.locator('html')).toHaveAttribute('data-camera-stops', '1');
  expect(await savedIdentity(page)).toBeNull();
  await fakeCamera(page, pairingLink(fixture.origin), 'blank');
  await page.getByRole('button', { name: 'Scan QR code' }).tap();
  await expect(page.locator('html')).toHaveAttribute('data-camera-requests', '1');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('html')).toHaveAttribute('data-camera-stops', '1');
  await expect(page.getByRole('alert')).toContainText('Camera stopped');
});

test('a camera timeout fits a narrow screen and releases a later permission grant', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '18px';
  });
  await fakeCamera(page, pairingLink(fixture.origin), 'pending');
  await page.clock.install();
  await page
    .getByRole('main', { name: 'Hosts and projects' })
    .locator('header')
    .getByRole('button', { name: 'Pair this device', exact: true })
    .tap();
  await page.getByRole('button', { name: 'Scan QR code' }).tap();
  const dialog = page.getByRole('dialog', { name: 'Pair this device' });
  expect(
    await dialog.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('pairing-scanner-mobile.png') });
  await page.clock.fastForward(20_001);
  await expect(page.getByRole('alert')).toContainText('camera did not start');
  await page.evaluate(() => document.dispatchEvent(new Event('fixture-camera-granted')));
  await expect(page.locator('html')).toHaveAttribute('data-camera-stops', '1');
  await expect(page.getByRole('button', { name: 'Scan QR code' })).toBeVisible();
  expect(await savedIdentity(page)).toBeNull();
});
