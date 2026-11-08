/* global window, document, MouseEvent */
import assert from 'node:assert/strict';

// Playwright retains a crashed Page flag after Electron reloads its renderer.
// Run observations and DOM menu gestures through the surviving native handle.
const render = (native, action) =>
  native.evaluate(
    (win, code) => win.webContents.executeJavaScript(code),
    `(${action.toString()})()`,
  );
const readDraft = (native) =>
  render(native, async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    return monaco.editor
      .getModels()
      .find((model) => model.uri.scheme === 'puddle' && model.uri.path.endsWith('README.md'))
      ?.getValue();
  });
const readTabs = (native) =>
  render(native, () => document.querySelectorAll('button[aria-label="Close README.md"]').length);

/** Crash real participants while docking into an already mounted host renderer. */
export async function checkDocking({
  application,
  host,
  pane,
  state,
  draft,
  text,
  arm,
  reached,
  expect,
}) {
  const release = () => application.evaluate(() => globalThis.nativeTransferFaults.release());
  const beginDock = async () => {
    await render(paneWindow, () =>
      document.querySelector('[data-pane-drag-handle]').dispatchEvent(
        new MouseEvent('contextmenu', {
          button: 2,
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
        }),
      ),
    );
    await expect
      .poll(() =>
        render(paneWindow, () =>
          [...document.querySelectorAll('[role="menuitem"]')].some((item) =>
            item.textContent.trim().startsWith('Return pane to '),
          ),
        ),
      )
      .toBe(true);
    await render(paneWindow, () =>
      [...document.querySelectorAll('[role="menuitem"]')]
        .find((item) => item.textContent.trim().startsWith('Return pane to '))
        .click(),
    );
  };
  const hostWindow = await application.browserWindow(host);
  const paneWindow = await application.browserWindow(pane);
  const paneId = (await pane.evaluate(() => window.puddleDesktop.windows.context())).identity.id;
  const profileId = (await pane.evaluate(() => window.puddleDesktop.windows.context())).identity
    .profileId;
  const sourceDraft = async () =>
    (await state()).entries[paneId].workspaces[profileId].content.buffers.map(
      (buffer) => buffer.content,
    );

  // Destination has mounted the incoming draft; the source has not committed.
  await arm('commit');
  await beginDock();
  const sourceCrash = await reached();
  await expect.poll(() => draft(host)).toBe(text);
  await paneWindow.evaluate((win) => win.webContents.forcefullyCrashRenderer());
  await expect.poll(async () => (await state()).outcomes[sourceCrash.id]?.status).toBe('cancelled');
  await expect.poll(() => readTabs(hostWindow)).toBe(0);
  assert.ok((await sourceDraft()).includes(text));
  await release();
  await Promise.all([
    pane.waitForEvent('domcontentloaded'),
    paneWindow.evaluate((win) => win.webContents.reload()),
  ]);
  await expect.poll(() => readDraft(paneWindow)).toBe(text);
  console.log('Docking source crash restores the host layout and the reloaded pane draft.');

  // The host itself crashes before acceptance. Reload must release stale presentation work.
  await arm('accept');
  await beginDock();
  const destinationCrash = await reached();
  await expect.poll(() => draft(host)).toBe(text);
  await hostWindow.evaluate((win) => win.webContents.forcefullyCrashRenderer());
  await expect
    .poll(async () => (await state()).outcomes[destinationCrash.id]?.status)
    .toBe('cancelled');
  await release();
  await expect.poll(() => readDraft(paneWindow)).toBe(text);
  assert.ok((await sourceDraft()).includes(text));
  await Promise.all([
    host.waitForEvent('domcontentloaded'),
    hostWindow.evaluate((win) => win.webContents.reload()),
  ]);
  await expect
    .poll(() => render(hostWindow, () => !!document.querySelector('header .profile-trigger')))
    .toBe(true);
  await expect.poll(() => readTabs(hostWindow)).toBe(0);

  // A fresh user action must succeed without a whole-app restart.
  await beginDock();
  await expect
    .poll(async () => {
      const message = await render(
        paneWindow,
        () => document.querySelector('[data-sonner-toast][data-type="error"]')?.textContent,
      ).catch(() => undefined);
      return { open: (await state()).entries[paneId].open, message };
    })
    .toMatchObject({ open: false });
  await expect.poll(() => readDraft(hostWindow)).toBe(text);
  await expect.poll(() => readTabs(hostWindow)).toBe(1);
  assert.equal(Object.keys((await state()).pending).length, 0);
  assert.equal((await state()).entries[paneId].open, false);
  console.log(
    'Docking destination crash preserves both layouts; docking after renderer reload succeeds.',
  );
}
