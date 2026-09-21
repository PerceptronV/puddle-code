import { expect, type Locator, type Page } from '@playwright/test';
import { websocket, until } from '../../cli/e2e/helpers';
import type { mobileFixture } from './mobile-fixture';

/** Browser-level touch input exercises gesture arbitration and native page scrolling. */
export async function swipe(page: Page, surface: Locator, direction: 'up' | 'down') {
  const bounds = await surface.boundingBox();
  if (!bounds) throw new Error('Missing swipe surface');
  const x = bounds.x + bounds.width / 2;
  const from = bounds.y + bounds.height * (direction === 'down' ? 0.25 : 0.75);
  const distance = bounds.height * (direction === 'down' ? 0.5 : -0.5);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: from, id: 1 }],
    });
    for (let step = 1; step <= 12; step++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: from + (distance * step) / 12, id: 1 }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

export async function expectStationaryPage(page: Page, topbarY: number) {
  expect((await page.locator('.remote-topbar').boundingBox())!.y).toBe(topbarY);
  expect(
    await page.evaluate(() => [
      window.scrollY,
      document.documentElement.scrollTop,
      document.body.scrollTop,
      document.getElementById('root')!.scrollTop,
      document.querySelector('.remote-ui')!.scrollTop,
    ]),
  ).toEqual([0, 0, 0, 0, 0]);
}

export async function checkTerminalScrolling(
  page: Page,
  fixture: Awaited<ReturnType<typeof mobileFixture>>,
) {
  const terminal = page.locator('.phone-terminal:not([hidden]) .xterm');
  const screen = terminal.locator('.xterm-screen');
  const rows = terminal.locator('.xterm-rows');
  const topbarY = (await page.locator('.remote-topbar').boundingBox())!.y;
  const viewer = await websocket(fixture.local.origin, fixture.local.credential);
  const session = fixture.session.id;
  viewer.send({ t: 'attach', session, term: 'agent', cols: 80, rows: 24 });
  await until(() => viewer.messages.some((message) => message.t === 'replay'), Boolean);
  const send = (data: string) => viewer.send({ t: 'stdin', session, term: 'agent', data });
  try {
    // The fake agent echoes input through the real PTY, connector and encrypted relay.
    send(Array.from({ length: 160 }, (_, line) => `SCROLL ${line}\n`).join(''));
    await expect(rows).toContainText('SCROLL 159');
    await terminal.locator('textarea').evaluate((element) => element.blur());
    const bottom = await rows.textContent();
    await swipe(page, screen, 'up'); // the bottom boundary must not drag the page
    await expect(rows).toHaveText(bottom!);
    await expectStationaryPage(page, topbarY);
    await swipe(page, screen, 'down');
    await expect(rows).not.toHaveText(bottom!);
    await expect(rows).not.toContainText('SCROLL 159');
    await expect(terminal.locator('textarea')).not.toBeFocused();
    await expectStationaryPage(page, topbarY);
    await swipe(page, screen, 'up');
    await expect(rows).toContainText('SCROLL 159');
    await screen.tap();
    await expect(terminal.locator('textarea')).toBeFocused();

    // Agent interfaces can own scrolling even in the normal buffer. Verify both
    // wheel directions reach the PTY using xterm's negotiated SGR mouse encoding.
    send('\x1b[?1000h\x1b[?1006hMOUSE READY\n');
    await expect(terminal).toHaveClass(/enable-mouse-events/);
    const start = viewer.messages.length;
    await swipe(page, screen, 'down');
    send('\n');
    await swipe(page, screen, 'up');
    send('\n');
    const output = () =>
      viewer.messages
        .slice(start)
        .filter((message) => message.t === 'output')
        .map((message) => ('data' in message ? message.data : ''))
        .join('');
    // eslint-disable-next-line no-control-regex -- Assert actual terminal protocol bytes.
    await until(output, (value) => /\x1b\[<64;\d+;\d+M/.test(value));
    // eslint-disable-next-line no-control-regex -- Assert actual terminal protocol bytes.
    await until(output, (value) => /\x1b\[<65;\d+;\d+M/.test(value));
    await expectStationaryPage(page, topbarY);
    send('\x1b[?1000l\x1b[?1006l\x1b[?1049hALT READY\n');
    await expect(terminal).not.toHaveClass(/enable-mouse-events/);
    await expect(rows).toContainText('ALT READY');
    const alternateStart = viewer.messages.length;
    await swipe(page, screen, 'down');
    send('\n');
    await until(
      () => viewer.messages.slice(alternateStart),
      (messages) =>
        messages.some((message) => message.t === 'output' && message.data.includes('\x1b[A')),
    );
    await expectStationaryPage(page, topbarY);
    send('\x1b[?1049lSCROLL COMPLETE\n');
    await expect(rows).toContainText('SCROLL COMPLETE');
  } finally {
    viewer.close();
  }
}
