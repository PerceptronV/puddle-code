/* global window, document, getComputedStyle -- browser fixture */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Feed actual VT sequences through the mounted xterm, including state written
// before Ripple is enabled. This catches changes to its pinned internal bridge.
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    new URL('/e2e/fixtures/ripple.html?live', process.env.PREVIEW_URL ?? 'http://127.0.0.1:5174/')
      .href,
  );
  await page.locator('.xterm').waitFor();
  const lines = [
    '\x1b[1mBold\x1b[0m \x1b[2mDim\x1b[0m \x1b[3mItalic\x1b[0m Normal',
    ...[1, 2, 3, 4, 5].map((n) => `\x1b[4:${n};58:2::18:52:86mUnderline${n}\x1b[0m`),
    '\x1b[21mDouble\x1b[0m \x1b[9;53mOverstrike\x1b[0m',
    '\x1b[38;2;17;34;51;48;2;68;85;102mTruecolour\x1b[0m',
    '\x1b[31mPalette\x1b[0m \x1b[1;31mBright\x1b[0m',
    '\x1b[38;5;200mIndexed\x1b[0m',
    '\x1b[7mInverse\x1b[0m \x1b[8mSECRET\x1b[0m Visible',
    '\x1b]8;id=docs;https://example.com/docs?a=1&b=2\x1b\\Linked label\x1b]8;;\x1b\\',
    '\x1b]8;;javascript:alert(1)\x1b\\Unsafe label\x1b]8;;\x1b\\',
    '界 e\u0301 😀 Unicode',
    '\x1b[1;3;4;9;53mStyled\x1b[22;23;24;29;55mReset',
    'Swatch:\x1b[48;2;12;34;56m    \x1b[0m',
  ];
  await page.evaluate((data) => window.rippleFixture.output(data), lines.join('\r\n'));
  await page.evaluate(() => window.rippleFixture.enable(true));
  const reader = page.locator('.ripple-prose');
  await reader.getByText('Bold', { exact: true }).waitFor();
  const style = (label, property) =>
    reader
      .getByText(label, { exact: true })
      .evaluate((node, key) => getComputedStyle(node)[key], property);
  assert.equal(await style('Bold', 'fontWeight'), '700');
  assert.equal(await style('Dim', 'opacity'), '0.5');
  assert.equal(await style('Italic', 'fontStyle'), 'italic');
  for (const [index, value] of ['solid', 'double', 'wavy', 'dotted', 'dashed'].entries()) {
    assert.equal(await style(`Underline${index + 1}`, 'textDecorationStyle'), value);
    assert.equal(await style(`Underline${index + 1}`, 'textDecorationColor'), 'rgb(18, 52, 86)');
  }
  assert.equal(await style('Double', 'textDecorationStyle'), 'double');
  assert.match(await style('Overstrike', 'textDecorationLine'), /overline/);
  assert.match(await style('Overstrike', 'textDecorationLine'), /line-through/);
  assert.equal(await style('Truecolour', 'color'), 'rgb(17, 34, 51)');
  assert.equal(await style('Truecolour', 'backgroundColor'), 'rgb(68, 85, 102)');
  assert.notEqual(await style('Palette', 'color'), await style('Bright', 'color'));
  assert.equal(await style('Indexed', 'color'), 'rgb(255, 0, 215)');
  assert.ok(!(await reader.innerText()).includes('SECRET'));
  assert.equal(
    await reader.getByRole('link', { name: 'Linked label' }).getAttribute('href'),
    'https://example.com/docs?a=1&b=2',
  );
  assert.equal(await reader.getByRole('link', { name: 'Unsafe label' }).count(), 0);
  assert.ok((await reader.innerText()).includes('界 e\u0301 😀 Unicode'));
  assert.equal(
    await reader
      .locator('[style]')
      .filter({ hasText: /^Reset$/ })
      .count(),
    0,
  );
  const swatch = reader.locator('[style*="background-color:#0c2238"]');
  assert.equal(await swatch.textContent(), '    ');
  assert.equal(await swatch.evaluate((node) => getComputedStyle(node).whiteSpace), 'break-spaces');
  const oldPalette = await style('Palette', 'color');
  // OSC palette/default changes apply to existing cells, without replaying text.
  await page.evaluate(() =>
    window.rippleFixture.output(
      '\x1b]4;1;rgb:12/34/56\x07\x1b]4;200;rgb:65/43/21\x07\x1b]10;rgb:23/45/67\x07\x1b]11;rgb:ef/ed/eb\x07',
    ),
  );
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.ripple-scroll')).backgroundColor ===
      'rgb(239, 237, 235)',
  );
  assert.equal(await style('Palette', 'color'), 'rgb(18, 52, 86)');
  assert.equal(await style('Indexed', 'color'), 'rgb(101, 67, 33)');
  assert.equal(await style('Inverse', 'color'), 'rgb(239, 237, 235)');
  assert.equal(await style('Inverse', 'backgroundColor'), 'rgb(35, 69, 103)');
  await page.evaluate(() => window.rippleFixture.output('\x1b]104\x07\x1b]110\x07\x1b]111\x07'));
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.ripple-scroll')).backgroundColor !==
      'rgb(239, 237, 235)',
  );
  assert.equal(await style('Palette', 'color'), oldPalette);
  await page.screenshot({ path: '/private/tmp/puddle-ripple-styles.png' });
  const screen = page.locator('.xterm-screen');
  const original = await screen.boundingBox();
  const resizes = await page.evaluate(
    () => window.rippleFixture.messages.filter((message) => message.t === 'resize').length,
  );
  await page.evaluate(() =>
    window.rippleFixture.output(
      '\x1b[2J\x1b[HReply\r\n\r\n\r\n› Native composer\r\n\r\nFooter\r\n',
    ),
  );
  await page.waitForFunction(() => !!document.querySelector('.ripple-native').style.transform);
  const aligned = await screen.boundingBox();
  assert.equal(aligned.height, original.height, 'bottom alignment keeps the full virtual screen');
  assert.ok(aligned.y > original.y, 'unused normal-buffer tail moves offscreen');
  assert.equal(
    await page.evaluate(
      () => window.rippleFixture.messages.filter((message) => message.t === 'resize').length,
    ),
    resizes,
    'alignment never resizes the PTY',
  );
  await page.getByRole('button', { name: 'Show CLI', exact: true }).click();
  assert.deepEqual(await screen.boundingBox(), original, 'Show CLI restores native placement');
  await page.getByRole('button', { name: 'Reading view', exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector('.ripple-native').style.transform);
  await page.getByRole('button', { name: 'CLI only', exact: true }).click();
  assert.deepEqual(await screen.boundingBox(), original, 'disabling restores native placement');
  assert.deepEqual(errors, []);
  console.log(
    'Ripple real-xterm SGR, extended underlines, palette/reset, concealment, Unicode and OSC 8 checks pass.',
  );
} finally {
  await browser.close();
}
