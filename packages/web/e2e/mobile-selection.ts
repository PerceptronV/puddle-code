import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { until, websocket } from '../../cli/e2e/helpers';
import type { mobileFixture } from './mobile-fixture';

export async function holdAndDrag(
  page: Page,
  surface: Locator,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const bounds = (await surface.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: bounds.x + from.x, y: bounds.y + from.y, id: 1 }],
    });
    await page.waitForTimeout(600);
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          {
            x: bounds.x + from.x + ((to.x - from.x) * step) / 8,
            y: bounds.y + from.y + ((to.y - from.y) * step) / 8,
            id: 1,
          },
        ],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

export async function checkTerminalSelection(
  page: Page,
  fixture: Awaited<ReturnType<typeof mobileFixture>>,
  testInfo: TestInfo,
) {
  await page
    .context()
    .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fixture.appOrigin });
  const terminal = page.locator('.phone-terminal:not([hidden]) .xterm');
  const rows = terminal.locator('.xterm-rows');
  const viewer = await websocket(fixture.local.origin, fixture.local.credential);
  const session = fixture.session.id;
  viewer.send({ t: 'attach', session, term: 'agent', cols: 80, rows: 24 });
  await until(() => viewer.messages.some((message) => message.t === 'replay'), Boolean);
  const send = (data: string) => viewer.send({ t: 'stdin', session, term: 'agent', data });
  try {
    for (const mode of ['normal', 'mouse', 'alternate']) {
      // The real fake-agent PTY echoes these control bytes into the browser terminal.
      const sequence =
        mode === 'mouse'
          ? '\x1b[?1000h\x1b[?1006h'
          : mode === 'alternate'
            ? '\x1b[?1000l\x1b[?1006l\x1b[?1049h'
            : '';
      send(`${sequence}\x1b[2J\x1b[HSELECT_ALPHA SELECT_BETA 日本語\nSELECT_SECOND end\n`);
      await expect(rows).toContainText('SELECT_SECOND');
      await terminal.locator('textarea').evaluate((element) => element.blur());
      const row = (await rows.locator(':scope > div').first().boundingBox())!;
      const screen = terminal.locator('.xterm-screen');
      await page.evaluate(() => navigator.clipboard.writeText('Unchanged clipboard'));
      const first = { x: 1, y: row.height / 2 };
      const second = { x: 150, y: row.height * 1.5 };
      await holdAndDrag(
        page,
        screen,
        mode === 'mouse' ? second : first,
        mode === 'mouse' ? first : second,
      );
      const actions = page.getByRole('toolbar', { name: 'Selected terminal text' });
      await expect(actions).toBeVisible();
      await expect(terminal.locator('textarea')).not.toBeFocused();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Unchanged clipboard');
      if (mode === 'normal')
        await page.screenshot({ path: testInfo.outputPath('phone-terminal-selection.png') });
      await actions.getByRole('button', { name: 'Copy', exact: true }).tap();
      await expect(actions).toHaveCount(0);
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toContain('SELECT_ALPHA SELECT_BETA 日本語');
      expect(copied).toContain('SELECT_SECOND');
    }
    send('\x1b[?1049l\x1b[?1000l\x1b[?1006lSELECTION COMPLETE\n');
    await expect(rows).toContainText('SELECTION COMPLETE');
  } finally {
    viewer.close();
  }
}
