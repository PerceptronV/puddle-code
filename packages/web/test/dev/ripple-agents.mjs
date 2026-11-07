/* global window, document, localStorage -- browser fixture */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Provider-shaped screens based on live Codex/Claude captures and the upstream
// Gemini UserMessage/InputPrompt and OpenCode UserMessage/SplitBorder components.
// Model responses are fixtures; real terminal parsing and interaction are tested.
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.addInitScript(() => localStorage.clear());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const agent of ['codex', 'claude-code', 'gemini-cli', 'opencode']) {
    await page.goto(
      new URL(
        `/e2e/fixtures/ripple.html?live&agent=${agent}`,
        process.env.PREVIEW_URL ?? 'http://127.0.0.1:5174/',
      ).href,
    );
    await page.waitForFunction(() => window.rippleFixture?.messages.some((m) => m.t === 'attach'));
    const { rows } = await page.evaluate(() =>
      window.rippleFixture.messages.findLast((m) => m.t === 'attach' || m.t === 'resize'),
    );
    const marker = { codex: '›', 'claude-code': '❯', 'gemini-cli': '>' }[agent];
    const box = (colour, label) =>
      `\x1b[38;2;${colour}m┃\x1b[48;2;230;230;230;38;2;20;20;20m  ${label}  \x1b[0m`;
    const user =
      agent === 'opencode'
        ? [
            box('40;80;200', 'Explain terminal rendering'),
            box('40;80;200', 'and preserve styling.'),
          ].join('\r\n')
        : `${marker} Explain terminal rendering\r\n  and preserve styling.`;
    const reply = '\x1b[1mReply heading\x1b[0m\r\nA response with \x1b[3mitalic text\x1b[0m.';
    const tool =
      agent === 'opencode' ? '\r\n\r\n' + box('255;255;255', 'Tool output stays literal') : '';
    const composer =
      agent === 'opencode'
        ? [
            box('40;80;200', ''),
            box('40;80;200', 'NATIVE DRAFT'),
            box('40;80;200', 'Build · Model'),
            '╹',
          ].join('\r\n')
        : `────────────────────\r\n${marker} NATIVE DRAFT\r\n────────────────────`;
    const inputRow = rows - 5;
    await page.evaluate(
      (data) => window.rippleFixture.output(data),
      '\x1b[?1049h\x1b[2J\x1b[H\x1b]11;rgb:ff/ff/ff\x07' +
        user +
        '\r\n\r\n' +
        reply +
        tool +
        `\x1b[${inputRow};1H` +
        composer +
        `\x1b[${inputRow + 1};7H`,
    );
    await page.evaluate(() => window.rippleFixture.enable(true));
    const bubble = page.locator('.ripple-user-turn');
    await bubble.filter({ hasText: 'Explain terminal rendering' }).waitFor();
    assert.equal(await bubble.count(), 1, `${agent} identifies only the user turn`);
    assert.ok((await bubble.innerText()).includes('and preserve styling.'));
    const reader = page.locator('.ripple-prose');
    assert.ok(
      !(await reader.innerText()).includes('NATIVE DRAFT'),
      `${agent} composer remains native`,
    );
    assert.ok(await reader.locator('[style*="font-weight:700"]').count());
    assert.ok(await reader.locator('[style*="font-style:italic"]').count());
    if (agent === 'opencode')
      assert.ok((await reader.innerText()).includes('Tool output stays literal'));
    await page.getByRole('button', { name: 'Type in CLI', exact: true }).click();
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowRight');
    const keys = await page.evaluate(() =>
      window.rippleFixture.messages.filter((m) => m.t === 'stdin').map((m) => m.data),
    );
    assert.deepEqual(keys.slice(-2), ['\x1b[1;2D', '\x1b[1;2C']);
    const boundary = page.getByRole('separator', { name: 'Native CLI boundary' });
    await boundary.focus();
    const previous = await boundary.getAttribute('aria-valuenow');
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(
      (old) =>
        document
          .querySelector('[aria-label="Native CLI boundary"]')
          .getAttribute('aria-valuenow') !== old,
      previous,
    );
    const saved = await boundary.getAttribute('aria-valuenow');
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.waitForTimeout(100);
    assert.equal(await boundary.getAttribute('aria-valuenow'), saved);
    await page.screenshot({ path: `/private/tmp/puddle-ripple-${agent}-layout.png` });
    await page.setViewportSize({ width: 1200, height: 900 });
  }
  assert.deepEqual(errors, []);
  console.log(
    'Ripple provider-shaped Codex, Claude, Gemini and OpenCode prompt, input, styling and resize checks pass.',
  );
} finally {
  await browser.close();
}
