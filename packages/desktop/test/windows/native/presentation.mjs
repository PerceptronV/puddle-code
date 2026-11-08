/* global document, performance */
import assert from 'node:assert/strict';

export async function checkNativeTitle(application, page, expect, title) {
  await expect(page.locator('header .profile-trigger')).toHaveCount(0);
  await expect(page).toHaveTitle(title);
  const afterStatus = await page.evaluate(async () => {
    const { wsManager } = await import(
      performance
        .getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname === '/src/lib/transport/ws.ts')?.name ??
        '/src/lib/transport/ws.ts'
    );
    wsManager.handle({
      t: 'status',
      session: '00000000-0000-4000-8000-000000000099',
      status: 'running',
    });
    return document.title;
  });
  assert.equal(afterStatus, title, 'unrelated host activity must retain the window title');
  const native = await application.browserWindow(page);
  await expect.poll(() => native.evaluate((win) => win.getTitle())).toBe(title);
  if (process.platform === 'darwin') {
    const inset = await native.evaluate((win) => win.getContentBounds().y - win.getBounds().y);
    assert.ok(inset >= 20, 'detached content must sit below a real native title bar');
  }
}

/** Wait for AppKit's completed transition, not only Electron's requested flag. */
export function changeFullScreen(nativeWindow, fullscreen) {
  return nativeWindow.evaluate(
    (win, value) =>
      new Promise((resolve, reject) => {
        const event = value ? 'enter-full-screen' : 'leave-full-screen';
        const timer = setTimeout(() => {
          win.removeListener(event, finished);
          reject(new Error('Native fullscreen transition timed out'));
        }, 15_000);
        function finished() {
          clearTimeout(timer);
          resolve();
        }
        win.once(event, finished);
        win.show();
        win.focus();
        win.setFullScreen(value);
      }),
    fullscreen,
  );
}
