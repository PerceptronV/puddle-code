/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
let page;
const errors = [];
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    new URL('/test/huddle/fixture.html', process.env.PREVIEW_URL ?? 'http://localhost:5174/').href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('My huddle');
  await page.getByRole('button', { name: 'Create huddle', exact: true }).click();
  await page.getByText('This huddle is empty.', { exact: true }).waitFor();
  await page.waitForFunction(() =>
    JSON.stringify(window.huddleFixture.state()).includes(
      'huddle:00000000-0000-4000-8000-000000000004',
    ),
  );
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  await page.getByRole('button', { name: 'Run event', exact: true }).click();
  await page.getByRole('complementary', { name: 'Node inspector' }).waitFor();
  await page.getByRole('button', { name: 'Node list', exact: true }).click();
  await page.getByText('run.event → result.value', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Graph', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await page.getByRole('button', { name: 'Reset zoom' }).filter({ hasText: '75%' }).waitFor();
  if (process.env.PUDDLE_HUDDLE_SCREENSHOTS) {
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        window.huddleFixture.theme(value);
      }, theme);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `/tmp/puddle-huddle-${theme}.png` });
    }
  }
  await page.getByRole('button', { name: 'Open definition', exact: true }).click();
  await page.waitForFunction(() =>
    JSON.stringify(window.huddleFixture.state()).includes(
      '.puddle/huddle/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/huddle.json',
    ),
  );
  await page.locator('[data-pane-tab="huddle:00000000-0000-4000-8000-000000000003"]').click();
  await page.getByRole('region', { name: 'Huddle editor' }).waitFor();
  await page.evaluate(() => {
    window.huddleFixture.available(false);
    window.huddleFixture.action('sidebar.right');
  });
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByText('Install a runtime with huddle support', { exact: true }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill('Unavailable');
  assert.equal(
    await page.getByRole('button', { name: 'Create huddle', exact: true }).isDisabled(),
    true,
  );
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 760, height: 900 });
  await page.getByRole('region', { name: 'Huddle editor' }).waitFor();
  const observed = await page.evaluate(() => ({
    messages: window.huddleFixture.messages,
    requests: window.huddleFixture.requests,
  }));
  assert.equal(
    observed.messages.some(
      (message) => message.t === 'attach' && /00000000000[34]$/.test(message.session),
    ),
    false,
  );
  assert.equal(
    observed.requests.filter(
      (request) => request.method === 'POST' && request.path.endsWith('/definitions'),
    ).length,
    1,
  );
  assert.equal(
    observed.requests.some((request) => /\/(start|run|resume)$/.test(request.path)),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Huddle create/open, graph inspection, source links, collapsed rail and narrow view passed without runtime dispatch or terminal attachment.',
  );
} catch (error) {
  console.error('Browser errors:', errors);
  console.error(await page?.locator('body').innerText());
  await page?.screenshot({ path: '/tmp/puddle-huddle-failure.png' });
  throw error;
} finally {
  await browser.close();
}
