/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { renderPrompt } from '../../../desktop/scripts/prompt-assets.mjs';
import { contrastRatio } from '../../scripts/contrast.mjs';

const browser = await chromium.launch({ headless: true });
const base = process.env.PREVIEW_URL ?? 'http://localhost:5174/';
const hex = (rgb) =>
  '#' +
  rgb
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map((n) => (+n).toString(16).padStart(2, '0'))
    .join('');
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  page.setDefaultTimeout(10000);
  await page.goto(base);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.waitFor();
  for (const theme of ['light', 'dark']) {
    for (const density of ['comfortable', 'compact']) {
      await page.evaluate(
        ({ theme, density }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.dataset.density = density;
          document.documentElement.style.setProperty('--ui-font-size', '20px');
        },
        { theme, density },
      );
      const colours = await settings.locator('.settings-navigation').evaluate((tray) => ({
        ink: getComputedStyle(tray.querySelector('[aria-current="page"]')).color,
        fill: getComputedStyle(tray.querySelector('.control-tray-selection')).backgroundColor,
      }));
      assert.ok(contrastRatio(hex(colours.ink), hex(colours.fill)) >= 4.5);
      await settings.getByRole('combobox').first().click();
      const list = page.getByRole('listbox');
      assert.equal(
        await list.evaluate((el) => getComputedStyle(el).animationName),
        'overlay-appear',
      );
      assert.notEqual(await list.evaluate((el) => getComputedStyle(el).boxShadow), 'none');
      const bounds = await list.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 1440);
      await page.keyboard.press('Escape');
    }
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.style.removeProperty('--ui-font-size');
  });
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  // Host identity uses primary text even when project/profile colours are customised.
  const host = page.locator('header a[href="/"] span').first();
  assert.equal(
    await host.evaluate((el) => getComputedStyle(el).color),
    await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--text-primary)';
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    }),
  );
  await page.locator('[data-path="README.md"]').dblclick();
  const close = page.getByRole('button', {
    name: 'Close README.md',
    exact: true,
    includeHidden: true,
  });
  await page.mouse.move(1400, 950);
  const tab = page
    .locator('[role="button"]')
    .filter({ has: page.locator('[aria-label="Close README.md"]') })
    .last();
  await page.keyboard.press('Tab');
  await tab.focus();
  await close.waitFor({ state: 'visible' });
  const before = await tab.boundingBox();
  // Reach the actions by Tab, rather than programmatically focusing a hidden button.
  let reached = false;
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    reached = await close.evaluate((el) => el === document.activeElement);
    if (reached) break;
  }
  assert.ok(reached, 'File close is keyboard reachable');
  assert.equal(await close.evaluate((el) => getComputedStyle(el.parentElement).opacity), '1');
  assert.equal((await tab.boundingBox()).width, before.width);

  // Internal stacked-island resize feedback keeps the gutter transparent.
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  const stageRows = page.locator('.sidebar-row button[aria-label^="Stage "]');
  await stageRows.first().waitFor({ state: 'attached' });
  const actionEdges = await stageRows.evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().right),
  );
  assert.ok(
    actionEdges.length >= 2 && Math.max(...actionEdges) - Math.min(...actionEdges) < 1,
    'Folder and file stage actions align',
  );
  const resize = page.getByRole('separator', { name: /uncommitted changes/i });
  await resize.hover();
  await page.waitForFunction(() => document.querySelectorAll('.island-resize-edge').length >= 2);
  assert.equal(
    await resize.evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgba(0, 0, 0, 0)',
  );
  assert.deepEqual(
    await page
      .locator('.island-resize-edge')
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).borderTopWidth)),
    ['3px', '3px'],
  );
  await resize.focus();
  const oldHeight = +(await resize.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowDown');
  assert.ok(+(await resize.getAttribute('aria-valuenow')) > oldHeight);
  await resize.evaluate((el) => el.blur());
  await page.mouse.move(1400, 950);
  await page.waitForFunction(() => document.querySelectorAll('.island-resize-edge').length === 0);

  // A content-sized collapsed island grows only to the space between controls
  // and archive, then scrolls as one surface even with many project groups.
  await page.getByRole('button', { name: 'Hide sessions', exact: true }).click();
  await page.waitForFunction(
    () => !document.documentElement.classList.contains('sidebar-transition'),
  );
  const sessionList = page.locator('.collapsed-session-list');
  const shortHeight = (await sessionList.boundingBox()).height;
  assert.ok(
    await sessionList.evaluate(
      (list) =>
        Math.abs(
          list.nextElementSibling.getBoundingClientRect().bottom -
            list.parentElement.getBoundingClientRect().bottom,
        ) < 2,
    ),
  );
  await sessionList.evaluate((list) => {
    const project = list.querySelector('.collapsed-session-project');
    for (let i = 0; i < 15; i++) list.append(project.cloneNode(true));
  });
  const limits = await sessionList.evaluate((list) => ({
    height: list.getBoundingClientRect().height,
    top: list.getBoundingClientRect().top,
    bottom: list.getBoundingClientRect().bottom,
    controls: list.previousElementSibling.getBoundingClientRect().bottom,
    archive: list.nextElementSibling.getBoundingClientRect().top,
    scrollHeight: list.scrollHeight,
    groupOutline: getComputedStyle(list.querySelector('.collapsed-session-project')).outlineStyle,
    divider: getComputedStyle(list.querySelectorAll('.collapsed-session-project')[1], '::before')
      .height,
  }));
  assert.ok(limits.height > shortHeight && limits.scrollHeight > limits.height);
  assert.ok(limits.top >= limits.controls && limits.bottom <= limits.archive);
  assert.equal(limits.groupOutline, 'none');
  assert.equal(limits.divider, '1px');
  await sessionList.evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  assert.ok(await sessionList.evaluate((list) => list.scrollTop > 0));
  await page.screenshot({ path: '/tmp/puddle-ui-quality-collapsed.png' });
  await page.getByRole('button', { name: 'Show sessions', exact: true }).click();
  await page.waitForFunction(
    () => !document.documentElement.classList.contains('sidebar-transition'),
  );

  // A small harness mounts the real shared component and checks identity isolation
  // and interrupted remounts without introducing a production-only demo surface.
  await page.evaluate(async () => {
    const { mountTrays } = await import('/test/dev/ui-quality-fixture.tsx');
    window.trayCheck = mountTrays();
    window.updateTrayCheck = window.trayCheck.update;
  });
  assert.deepEqual(errors, []);
  const markers = page.locator('#tray-check .control-tray-selection');
  const first = await markers.nth(0).boundingBox();
  const second = await markers.nth(1).boundingBox();
  assert.ok(second.x > first.x + 50, 'Same-labelled trays have independent selections');
  await page.evaluate(() => window.updateTrayCheck({ slot: 2, generation: 0 }));
  await page.waitForTimeout(45);
  const jump = await page.evaluate(() => {
    const before = document
      .querySelector('#tray-check .control-tray-selection')
      .getBoundingClientRect().x;
    window.updateTrayCheck({ slot: 2, generation: 1 });
    const after = document
      .querySelector('#tray-check .control-tray-selection')
      .getBoundingClientRect().x;
    return Math.abs(after - before);
  });
  assert.ok(jump < 2, `Interrupted selection remount jumped ${jump}px`);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.documentElement.dataset.reduceMotion === 'true');
  await page.evaluate(() => window.updateTrayCheck({ slot: 0, generation: 1 }));
  assert.equal(
    await markers.nth(0).evaluate((el) => getComputedStyle(el).transitionDuration),
    '0s',
  );
  await page.screenshot({ path: '/tmp/puddle-ui-quality-desktop.png' });
  assert.deepEqual(errors, []);

  await page.evaluate(() => window.trayCheck.remove());
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const phone = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  phone.on('pageerror', (error) => errors.push(error.message));
  await phone.goto(base);
  await phone.getByRole('button', { name: 'Close', exact: true }).click();
  await phone.evaluate(async () => {
    const { mountPhone } = await import('/test/dev/ui-quality-fixture.tsx');
    window.removePhoneCheck = mountPhone();
  });
  assert.equal(await phone.locator('#phone-check aside').count(), 0);
  const selector = phone.getByRole('button', { name: 'Switch session', exact: true });
  const menu = phone.getByRole('menu', { name: 'Switch session' });
  const promptDraft = phone.getByRole('textbox', { name: 'Prompt', exact: true });
  await promptDraft.fill('Retain my draft');
  assert.equal(await promptDraft.inputValue(), 'Retain my draft');
  assert.notEqual(
    await promptDraft.evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgba(0, 0, 0, 0)',
  );
  assert.ok(+(await promptDraft.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))) >= 16);
  await selector.tap();
  await menu.evaluate((el) =>
    Promise.all(el.getAnimations().map((animation) => animation.finished)),
  );
  assert.ok(
    (await menu.getByRole('menuitem', { name: 'New agent', exact: true }).boundingBox()).height >=
      44,
  );
  assert.ok((await menu.boundingBox()).width <= 390);
  await menu.getByRole('menuitemcheckbox', { name: /Review the layout$/ }).tap();
  assert.equal(await selector.textContent(), 'Review the layout');
  await selector.tap();
  assert.equal(
    await menu
      .getByRole('menuitemcheckbox', { name: /Review the layout$/ })
      .getAttribute('aria-checked'),
    'true',
  );
  await menu.getByRole('menuitem', { name: 'Archived sessions', exact: true }).tap();
  await phone.getByRole('dialog', { name: 'Archived sessions' }).waitFor();
  await phone
    .getByRole('dialog', { name: 'Archived sessions' })
    .evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
  await phone.screenshot({ path: '/tmp/puddle-ui-quality-phone.png' });
  await phone
    .getByRole('dialog', { name: 'Archived sessions' })
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await phone.evaluate(() => window.removePhoneCheck());
  assert.deepEqual(errors, []);

  await phone.close();

  // Packaged standalone pages: no frontend/daemon, same palette and saved preference.
  const prompts = await browser.newContext();
  await prompts.addInitScript(() => {
    window.puddlePrompt = { submit() {}, cancel() {}, onStatus() {} };
    window.puddlePicker = {
      recents: async () => ['build-box'],
      choose() {},
      other() {},
      cancel() {},
      onStatus() {},
    };
    window.puddleSshAuth = {
      submit() {},
      cancel() {},
      onRequest(cb) {
        cb({ target: 'build-box', prompt: 'Password:', kind: 'password' });
      },
    };
  });
  await prompts.route('http://prompt.test/**', (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    return route.fulfill({ contentType: 'text/html', body: renderPrompt(name) });
  });
  const prompt = await prompts.newPage();
  for (const name of ['connect-prompt', 'host-picker', 'ssh-auth-prompt']) {
    for (const theme of ['light', 'dark']) {
      await prompt.goto(`http://prompt.test/${name}?theme=${theme}`);
      assert.equal(await prompt.evaluate(() => document.documentElement.dataset.theme), theme);
      const actual = await prompt.locator('body').evaluate((el) => ({
        colour: getComputedStyle(el).color,
        background: getComputedStyle(el).backgroundColor,
      }));
      assert.ok(contrastRatio(hex(actual.colour), hex(actual.background)) >= 4.5);
      const primary = prompt.locator('button.primary');
      if (await primary.count()) {
        const pair = await primary.evaluate((el) => ({
          colour: getComputedStyle(el).color,
          background: getComputedStyle(el).backgroundColor,
        }));
        assert.ok(contrastRatio(hex(pair.colour), hex(pair.background)) >= 4.5);
      }
    }
    await prompt.goto(`http://prompt.test/${name}?theme=system`);
    await prompt.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await prompt.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await prompt.emulateMedia({ colorScheme: 'dark' });
    await prompt.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  }
  await prompts.close();
  console.log(
    'UI quality: selection contrast, menus, keyboard actions, resize edges, tray identity/continuity, reduced motion, and native prompt themes pass.',
  );
} finally {
  await browser.close();
}
