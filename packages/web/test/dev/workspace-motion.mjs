/* global window, document, Element, getComputedStyle, Event */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.motionRecords = [];
    window.tabEntries = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      window.motionRecords.push({
        frames,
        expansion: this.hasAttribute('data-expanding-content'),
        snapshot: this.hasAttribute('data-motion-snapshot'),
      });
      return animate.call(this, frames, options);
    };
    document.addEventListener('animationstart', (event) => {
      if (event.target.hasAttribute('data-pane-tab')) window.tabEntries.push(event.animationName);
    });
  });
  await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('[data-path="package.json"]').dblclick();
  await page.locator('[data-path="README.md"]').click();
  await page.waitForTimeout(250);
  const preview = page.locator('[data-pane-tab].italic');
  assert.equal(await preview.count(), 1);
  await preview.evaluate((element) => {
    window.previewChip = element;
  });
  await page.getByRole('tree').focus();
  await page.evaluate(() => {
    window.motionRecords = [];
    window.tabEntries = [];
  });
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(80);
  const selected = await page
    .locator('[data-path][aria-selected="true"]')
    .first()
    .getAttribute('data-path');
  assert.notEqual(selected, 'README.md');
  assert.ok((await preview.getAttribute('data-pane-tab')).includes(selected));
  assert.equal(await preview.evaluate((element) => element === window.previewChip), true);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'tree');
  assert.equal(
    await page.evaluate(() => window.motionRecords.length),
    0,
    'preview replacement has no cross-fade',
  );
  assert.deepEqual(await page.evaluate(() => window.tabEntries), [], 'preview chip stays mounted');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-pane-tab].italic').count(), 0, 'Enter pins the file');
  await page.keyboard.press('Shift+ArrowDown');
  assert.equal(
    await page.locator('[data-pane-tab].italic').count(),
    0,
    'range selection does not open files',
  );
  const paneEdge = await page
    .locator('[data-workspace-pane]')
    .first()
    .evaluate((element) => ({
      clip: getComputedStyle(element).overflow,
      edge: getComputedStyle(element, '::after').boxShadow,
      pointer: getComputedStyle(element, '::after').pointerEvents,
    }));
  assert.equal(paneEdge.clip, 'clip');
  assert.notEqual(paneEdge.edge, 'none');
  assert.equal(paneEdge.pointer, 'none');

  await page.getByRole('button', { name: 'Scratchpad', exact: true }).click();
  await page.getByText('Review checklist', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.motionRecords = [];
  });
  await page.getByRole('button', { name: 'New entry', exact: true }).click();
  await page.getByPlaceholder('Prompt or note…').waitFor();
  let records = await page.evaluate(() => window.motionRecords);
  assert.ok(
    records.some(
      (record) =>
        record.expansion &&
        parseFloat(record.frames[1].height) > parseFloat(record.frames[0].height),
    ),
    'composer expands actual height',
  );
  assert.ok(
    records.some((record) => record.frames[0].opacity === 0),
    'composer fades in',
  );
  await page.waitForTimeout(220);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForTimeout(220);
  await page.evaluate(() => {
    window.motionRecords = [];
  });
  await page.getByText('Review checklist', { exact: true }).click();
  await page.getByPlaceholder('Prompt or note…').waitFor();
  records = await page.evaluate(() => window.motionRecords);
  assert.ok(
    records.some(
      (record) =>
        record.expansion &&
        parseFloat(record.frames[1].height) > parseFloat(record.frames[0].height),
    ),
    'editing slides following rows',
  );
  await page.waitForTimeout(220);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForTimeout(220);
  await page.getByRole('button', { name: 'Scratchpad', exact: true }).click();

  await page.getByRole('button', { name: 'Layouts', exact: true }).click();
  await page.getByPlaceholder('Name this layout…').fill('Motion review');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Motion review').first().waitFor();
  await page.waitForTimeout(220);
  await page.evaluate(() => {
    window.motionRecords = [];
  });
  await page
    .getByRole('button', { name: 'Save the current layout as a new layout', exact: true })
    .click();
  await page.getByPlaceholder('Save as a new layout…').waitFor();
  records = await page.evaluate(() => window.motionRecords);
  assert.ok(
    records.some((record) => record.expansion),
    'layout composer slides the list',
  );
  await page.waitForTimeout(220);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForTimeout(220);
  await page.getByRole('button', { name: 'Layouts', exact: true }).click();

  // Both app and OS settings stop JS animation work as well as CSS transitions.
  for (const system of [false, true]) {
    await page.evaluate(async (system) => {
      const { updateClientSettings } = await import('/src/lib/settings/client-settings.ts');
      updateClientSettings({ reduceMotion: !system });
    }, system);
    await page.emulateMedia({ reducedMotion: system ? 'reduce' : 'no-preference' });
    await page.getByRole('button', { name: 'Scratchpad', exact: true }).click();
    await page.evaluate(() => {
      window.motionRecords = [];
    });
    await page.getByText('Review checklist', { exact: true }).click();
    await page.getByPlaceholder('Prompt or note…').waitFor();
    assert.equal(await page.evaluate(() => window.motionRecords.length), 0);
    assert.equal(await page.locator('[data-motion-snapshot]').count(), 0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Scratchpad', exact: true }).click();
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(async () => {
    const { updateClientSettings } = await import('/src/lib/settings/client-settings.ts');
    updateClientSettings({ reduceMotion: false });
  });
  const projectHeader = page.locator('[data-sidebar-motion="sessions-project-0000000002"]');
  await projectHeader.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Change project colour', exact: true }).click();
  const colours = page.getByRole('group', { name: 'Project colour', exact: true });
  assert.ok(await colours.getByRole('button', { name: 'blue', exact: true }).isVisible());
  assert.ok(
    await colours.getByRole('button', { name: 'Custom project colour', exact: true }).isVisible(),
  );
  assert.equal(
    await colours
      .getByRole('button', { name: 'Default colour', exact: true })
      .locator('span')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    'rgb(107, 107, 107)',
  );
  await colours.locator('input[type="color"]').evaluate((input) => {
    input.value = '#12a6bc';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(
    () =>
      getComputedStyle(
        document.querySelector('[data-sidebar-motion="sessions-project-0000000002"]'),
      ).color === 'rgb(18, 166, 188)',
  );
  await page.getByTitle('All projects', { exact: true }).click();
  await page.getByRole('button', { name: /^Open terminal/ }).waitFor();
  await page.waitForTimeout(220);
  await page.evaluate(() => {
    window.motionRecords = [];
  });
  await page.getByRole('button', { name: /^Open terminal/ }).click();
  await page.getByRole('button', { name: /^Close terminal/ }).waitFor();
  assert.ok(
    await page.evaluate(() => window.motionRecords.some((record) => record.expansion)),
    'dashboard terminal enters',
  );
  await page.waitForTimeout(220);
  await page.evaluate(() => {
    window.motionRecords = [];
  });
  await page.getByRole('button', { name: /^Close terminal/ }).click();
  assert.ok(
    await page.evaluate(() => window.motionRecords.some((record) => record.snapshot)),
    'dashboard terminal fades out',
  );
  await page.waitForTimeout(220);
  await page.evaluate(async () => {
    window.motionRecords = [];
    const { profileStore } = await import('/src/features/profile/profile-store.ts');
    profileStore.set(null);
  });
  await page.getByText('Who is working?', { exact: true }).waitFor();
  assert.ok(
    await page.evaluate(() => window.motionRecords.some((record) => record.snapshot)),
    'profile picker cross-fades in',
  );
  await page.waitForTimeout(220);
  await page.evaluate(() => {
    window.motionRecords = [];
  });
  await page.getByRole('button', { name: /^Preview/ }).click();
  await page.getByRole('button', { name: /^Open terminal/ }).waitFor();
  assert.ok(
    await page.evaluate(() => window.motionRecords.some((record) => record.snapshot)),
    'profile picker cross-fades out',
  );
  await page.waitForTimeout(220);
  await page.screenshot({ path: '/tmp/puddle-workspace-motion.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Preview-slot browsing, keyboard pinning, pane clipping, inline expansion/fades and app/OS reduced motion pass.',
  );
} finally {
  await browser.close();
}
