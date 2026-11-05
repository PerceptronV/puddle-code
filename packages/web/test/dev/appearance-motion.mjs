/* global document, window, getComputedStyle, localStorage, DOMMatrix */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.motionChecks = [];
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (callback) => {
      const transition = start(callback);
      transition.ready.then(
        () => {
          const main = document.querySelector('[data-sidebar-main]');
          window.motionChecks.push({
            names: [...document.querySelectorAll('[style*="view-transition-name"]')].map(
              (element) => element.style.viewTransitionName,
            ),
            mainFrames:
              main
                ?.getAnimations()
                .flatMap((animation) =>
                  animation.effect.getKeyframes().map((frame) => frame.width),
                ) ?? [],
          });
        },
        (error) => window.motionChecks.push({ error: error.message }),
      );
      return transition;
    };
  });
  await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const nav = () => page.getByRole('group', { name: 'Navigators', exact: true });
  await nav().getByRole('button', { name: 'Worktrees', exact: true }).click();
  await page.waitForTimeout(220);
  await nav().getByRole('button', { name: 'Files', exact: true }).click();
  assert.ok(
    await nav()
      .locator('.control-tray-selection')
      .evaluate((element) =>
        element
          .getAnimations()
          .some((animation) =>
            animation.effect
              .getKeyframes()
              .some((frame) => frame.transform && new DOMMatrix(frame.transform).m41 > 50),
          ),
      ),
  );
  await page.waitForTimeout(220);
  const from = await nav().getByRole('button', { name: 'Files', exact: true }).boundingBox();
  const to = await nav().getByRole('button', { name: 'Search', exact: true }).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Navigators"] button[aria-current="page"]')
        ?.textContent === 'Search',
  );
  assert.deepEqual(
    await nav().evaluate((element) =>
      ['.tray-hover-surface', '.control-tray-selection', 'button'].map(
        (selector) => +getComputedStyle(element.querySelector(selector)).zIndex,
      ),
    ),
    [0, 1, 2],
  );

  for (const [hide, show] of [
    ['Hide sidebar', 'Show sidebar'],
    ['Hide sessions', 'Show sessions'],
  ]) {
    await page.getByRole('button', { name: hide, exact: true }).click();
    await page.waitForFunction(
      () => !document.documentElement.classList.contains('sidebar-transition'),
    );
    await page.getByRole('button', { name: show, exact: true }).click();
    await page.waitForFunction(
      () => !document.documentElement.classList.contains('sidebar-transition'),
    );
  }
  const transitions = await page.evaluate(() => window.motionChecks);
  assert.equal(transitions.length, 4);
  assert.ok(
    transitions.every(
      (transition) =>
        !transition.error &&
        transition.names.some((name) =>
          name.startsWith('sidebar-74-72-61-79-2d-73-65-6c-65-63-74-69-6f-6e'),
        ),
    ),
  );
  assert.ok(
    transitions.every(
      (transition) =>
        transition.mainFrames.length >= 2 &&
        transition.mainFrames[0] !== transition.mainFrames.at(-1),
    ),
  );

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  assert.equal(
    await dialog.evaluate((element) => getComputedStyle(element).animationName),
    'overlay-appear',
  );
  await page.getByRole('switch', { name: 'Reduced animation and motion', exact: true }).click();
  assert.equal(await dialog.evaluate((element) => getComputedStyle(element).animationName), 'none');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.reduceMotion), 'true');
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.reduceMotion === 'true');
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('puddle.client-settings')).reduceMotion,
    ),
    true,
  );
  await page
    .getByRole('dialog', { name: 'Settings', exact: true })
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await page.getByRole('button', { name: 'Hide sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Show sessions', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.motionChecks), []);
  assert.deepEqual(errors, []);
  console.log(
    'Tray selection/drag/layers, individual sidebar counterparts, live editor resize, overlay animation, and reduced-motion persistence pass.',
  );
} finally {
  await browser.close();
}
