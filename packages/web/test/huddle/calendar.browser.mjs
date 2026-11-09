import { inspectNode, chooseHuddleOption } from './helpers/controls.mjs';
/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(
    new URL('/test/huddle/fixture.html', process.env.PREVIEW_URL ?? 'http://localhost:5174/').href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Huddle editor' });
  const inspector = editor.getByRole('complementary', { name: 'Node inspector' });
  const add = async (name) => {
    await editor.getByRole('button', { name: 'Add node', exact: true }).click();
    await editor.getByRole('button', { name: `Add ${name}`, exact: true }).click();
    await editor.getByRole('button', { name: 'Add node', exact: true }).click();
    await inspectNode(editor.getByRole('button', { name: `${name} event`, exact: true }));
  };
  const setText = async (name, value) => {
    const group = inspector.getByRole('group', { name, exact: true });
    await group.getByRole('textbox').fill(value);
    await group.getByRole('button', { name: 'Apply setting' }).click();
  };
  await editor.getByRole('button', { name: 'Add node', exact: true }).click();
  assert.equal(
    await editor.getByRole('button', { name: 'Add Monthly / yearly', exact: true }).count(),
    0,
  );
  await editor.getByRole('button', { name: 'Add node', exact: true }).click();
  await add('Calendar');
  assert.equal(
    await inspector
      .getByRole('group', { name: 'Timezone', exact: true })
      .getByRole('textbox')
      .inputValue(),
    'UTC',
  );
  assert.equal(
    await inspector
      .getByRole('group', { name: 'Local time', exact: true })
      .getByRole('textbox')
      .inputValue(),
    '09:00',
  );
  await setText('Timezone', 'Europe/London');
  await setText('Local time', '10:15');
  await setText('Weekdays', '[1,3,5]');
  if (process.env.PUDDLE_HUDDLE_SCREENSHOTS) {
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => window.huddleFixture.theme(theme), theme);
      await page.waitForTimeout(250); // Let shared theme colour transitions settle before capture.
      await page.screenshot({ path: `/tmp/puddle-huddle-calendar-${theme}.png` });
    }
  }
  await add('Date and time');
  assert.equal(
    await inspector
      .getByRole('group', { name: 'Date and time', exact: true })
      .getByRole('textbox')
      .inputValue(),
    '',
  );
  await setText('Date and time', '2027-03-01T09:00:00+01:00');
  const past = inspector.getByRole('group', { name: 'If already past when armed', exact: true });
  await chooseHuddleOption(
    past.getByLabel('If already past when armed *', { exact: true }),
    'skip',
  );
  await past.getByRole('button', { name: 'Apply setting' }).click();
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() =>
    window.huddleFixture.source().nodes.some((node) => node.id === 'date'),
  );
  assert.deepEqual(
    await page.evaluate(
      () => window.huddleFixture.source().nodes.find((node) => node.id === 'calendar').parameters,
    ),
    {
      timeZone: { kind: 'literal', value: 'Europe/London' },
      time: { kind: 'literal', value: '10:15' },
      weekdays: { kind: 'literal', value: [1, 3, 5] },
    },
  );
  assert.deepEqual(
    await page.evaluate(
      () => window.huddleFixture.source().nodes.find((node) => node.id === 'date').parameters,
    ),
    {
      at: { kind: 'literal', value: '2027-03-01T09:00:00+01:00' },
      past: { kind: 'literal', value: 'skip' },
    },
  );
  assert.equal(
    await page.evaluate(() =>
      window.huddleFixture.requests.some((request) =>
        /\/(start|apply|run|rearm)$/.test(request.path),
      ),
    ),
    false,
  );
  assert.deepEqual(errors, []);
  await page.goto(
    new URL(
      '/test/huddle/fixture.html?source-saves',
      process.env.PREVIEW_URL ?? 'http://localhost:5174/',
    ).href,
  );
  await page.waitForFunction(() => !!window.huddleFixture);
  await page.evaluate(() => window.huddleFixture.releaseProjects());
  await page.getByRole('button', { name: 'New huddle', exact: true }).click();
  await page.getByRole('button', { name: 'Review graph', exact: true }).click();
  await add('Monthly / yearly');
  await setText('Months', '[2]');
  const day = inspector.getByRole('group', { name: 'Day of month', exact: true });
  await day.getByRole('spinbutton').fill('29');
  await day.getByRole('button', { name: 'Apply setting' }).click();
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() =>
    window.huddleFixture.source().nodes.some((node) => node.id === 'calendar-date'),
  );
  assert.deepEqual(
    await page.evaluate(
      () =>
        window.huddleFixture.source().nodes.find((node) => node.id === 'calendar-date').parameters,
    ),
    {
      months: { kind: 'literal', value: [2] },
      day: { kind: 'literal', value: 29 },
    },
  );
  assert.equal(
    await page.evaluate(() =>
      window.huddleFixture.requests.some((request) =>
        /\/(start|apply|run|rearm)$/.test(request.path),
      ),
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Calendar/date and monthly/yearly settings save without arming; older hosts omit the new node.',
  );
} catch (error) {
  console.error(await page.locator('body').innerText());
  await page.screenshot({ path: '/tmp/puddle-huddle-calendar-failure.png' });
  throw error;
} finally {
  await browser.close();
}
