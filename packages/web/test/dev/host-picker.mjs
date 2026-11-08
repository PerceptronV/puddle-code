/* global window, document, getComputedStyle */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { renderPrompt } from '../../../desktop/scripts/prompt-assets.mjs';

const browser = await chromium.launch({ headless: true });
try {
  const frontend = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await frontend.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
  await frontend.getByRole('button', { name: 'Close', exact: true }).click();
  await frontend.getByRole('button', { name: 'Settings', exact: true }).click();
  await frontend
    .getByRole('group', { name: 'Settings sections' })
    .getByRole('button', { name: 'Host', exact: true })
    .click();
  await frontend.getByRole('button', { name: 'Choose a host icon' }).click();
  await frontend.getByRole('button', { name: 'origami', exact: true }).click();
  await frontend
    .getByRole('group', { name: 'Host accent', exact: true })
    .getByRole('button', { name: 'green', exact: true })
    .click();
  await frontend.waitForFunction(
    () =>
      JSON.parse(document.documentElement.dataset.desktopHostIdentity ?? '{}').colour === 'green',
  );
  const identity = await frontend.evaluate(() =>
    JSON.parse(document.documentElement.dataset.desktopHostIdentity),
  );
  assert.ok(identity.name);
  assert.ok(identity.icon.length);
  assert.equal(identity.colour, 'green');

  const page = await browser.newPage({ viewport: { width: 380, height: 400 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate((identity) => {
    window.puddlePicker = {
      recents: async () => [
        { target: 'local', identity: { ...identity, name: 'My laptop', colour: '#12a6bc' } },
        { target: 'user@compute', identity: { ...identity, name: 'Compute' } },
        { target: 'user@unseen', identity: null },
      ],
      choose: (target) => {
        window.chosenHost = target;
      },
      other: () => {
        window.chosenHost = 'other';
      },
      cancel() {},
      onHosts: (callback) => {
        window.updatePickerHosts = callback;
      },
      onStatus: (callback) => {
        window.pickerStatus = callback;
      },
    };
  }, identity);
  await page.setContent(renderPrompt('host-picker'));
  const local = page.getByRole('button', { name: 'My laptop local', exact: true });
  const remote = page.getByRole('button', { name: 'Compute ssh', exact: true });
  await local.waitFor();
  assert.equal(await remote.getAttribute('title'), 'user@compute');
  assert.equal(await remote.locator('svg > *').count(), identity.icon.length);
  assert.equal(await remote.getAttribute('data-colour'), 'green');
  assert.equal(await local.getAttribute('data-colour'), '#12a6bc');
  assert.equal(await page.getByRole('button', { name: 'user@unseen ssh' }).count(), 1);
  const colours = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    colours.push(await remote.evaluate((el) => getComputedStyle(el).color));
  }
  assert.notEqual(colours[0], colours[1], 'Preset colours adapt to the prompt theme');
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await page.screenshot({ path: '/tmp/puddle-host-picker.png' });
  await remote.click();
  assert.equal(await page.evaluate(() => window.chosenHost), 'user@compute');
  await page.evaluate(
    (identity) =>
      window.updatePickerHosts([
        { target: 'local', identity: { ...identity, name: '<b>Renamed</b>' } },
      ]),
    identity,
  );
  assert.equal(await page.locator('#hosts b').count(), 0, 'Names stay text');
  await page.getByRole('button', { name: '<b>Renamed</b> local' }).click();
  assert.equal(await page.evaluate(() => window.chosenHost), 'local');
  await page.evaluate(() => window.pickerStatus({ state: 'connecting' }));
  assert.equal(await page.getByRole('button', { name: '<b>Renamed</b> local' }).isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log(
    'Desktop host projection, names, icons, colours, live updates and exact target selection passed.',
  );
} finally {
  await browser.close();
}
