/* global window */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNativePreview } from './build.mjs';
import { measureNativeWindows } from './resources.mjs';
import { checkNativeTitle, changeFullScreen } from './presentation.mjs';
import { checkMissingResources } from './recovery.mjs';
import { checkCleanPaneClose, prepareUntitledClose, finishUntitledClose } from './close.mjs';

const require = createRequire(import.meta.url);
const { _electron: electron, expect } = createRequire(
  new URL('../../../../web/package.json', import.meta.url),
)('@playwright/test');
const directory = await mkdtemp(join(tmpdir(), 'puddle-native-windows-'));
const preview = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5186/';
const dirtyText = 'Unsaved native window acceptance text';
let application;
const errors = [];
const recoveryOnly = process.env.PUDDLE_NATIVE_RECOVERY_ONLY === '1';
const samples = [];
const measure = async (phase, editor) => {
  if (!process.env.PUDDLE_NATIVE_REPORT) return;
  samples.push(await measureNativeWindows(application, phase, editor));
  await writeFile(
    process.env.PUDDLE_NATIVE_REPORT,
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        timestamp: new Date().toISOString(),
        electron: await application.evaluate(() => process.versions.electron),
        samples,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Native resource sample: ${phase}.`);
};
const launch = async () => {
  application = await electron.launch({
    executablePath: require('electron'),
    args: [join(directory, 'entry.cjs')],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      PUDDLE_NATIVE_TEST_HOME: join(directory, 'home'),
      PREVIEW_URL: preview,
    },
    timeout: 30_000,
  });
  application.process().stderr.on('data', (data) => process.stderr.write(data));
  application.process().stdout.on('data', (data) => process.stdout.write(data));
  application.on('window', (page) => page.on('pageerror', (error) => errors.push(error.message)));
};
const state = async () => JSON.parse(await readFile(join(directory, 'home/reopen-windows.json')));
const identity = (page) => page.evaluate(() => window.puddleDesktop.windows.context());
const dirtyEditor = async (page) => {
  await page.locator('[data-editor-surface] .monaco-editor').first().waitFor();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
        return monaco.editor.getEditors().map((editor) => editor.getModel()?.getValue());
      }),
    )
    .toContain(dirtyText);
};
const quit = async () => {
  const closed = application.waitForEvent('close');
  await application.evaluate(({ app }) => app.quit());
  await closed;
  application = undefined;
};
try {
  await buildNativePreview(directory);
  await launch();
  const host = await application.firstWindow();
  console.log('Native host opened; preparing a dirty file through the explorer.');
  await host
    .locator('[data-release-notes]')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await host
    .locator('[data-sidebar-motion="sessions-item-00000000-0000-4000-8000-000000000001"]')
    .dblclick();
  await host.locator('[data-path="README.md"]').first().dblclick();
  await host.locator('[data-editor-surface] .monaco-editor').first().waitFor();
  const initial = await identity(host);
  assert.equal(initial.identity.kind, 'host');
  await host.evaluate(async (value) => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    monaco.editor
      .getEditors()
      .find((editor) => editor.getModel()?.uri.scheme === 'puddle')
      .getModel()
      .setValue(value);
  }, dirtyText);
  await measure('host', host);
  const strip = host.locator('[data-pane-drag-handle]').first();
  const box = await strip.boundingBox();
  await strip.click({ button: 'right', position: { x: box.width - 8, y: 12 } });
  const [pane] = await Promise.all([
    application.waitForEvent('window'),
    host.getByRole('menuitem', { name: 'Open pane in window', exact: true }).click(),
  ]);
  await dirtyEditor(pane);
  await expect(pane.locator('header .profile-trigger')).toHaveCount(0);
  const paneIdentity = await identity(pane);
  assert.equal(paneIdentity.identity.kind, 'pane');
  await expect.poll(async () => Object.keys((await state()).pending).length).toBe(0);
  await checkNativeTitle(application, pane, expect, 'README.md');
  console.log('Native pane context action and acknowledged dirty-editor transfer passed.');
  await measure('host-and-pane', pane);

  await host.evaluate(async () =>
    (await import('/src/features/windows/navigation/project-actions.ts')).navigateProjectRoute('/'),
  );
  await host.locator('a[href="/project/0000000002"]').first().click({ button: 'right' });
  const [project] = await Promise.all([
    application.waitForEvent('window'),
    host.getByRole('menuitem', { name: 'Open project in window', exact: true }).click(),
  ]);
  await expect.poll(async () => (await identity(project)).identity.kind).toBe('project');
  await expect.poll(async () => Object.keys((await state()).pending).length).toBe(0);
  await checkNativeTitle(application, project, expect, 'puddle');
  await checkCleanPaneClose(application, project, expect, state);
  assert.deepEqual(await application.evaluate(() => globalThis.nativePreviewConnections), {
    starts: 1,
    closes: 0,
  });
  const projectIdentity = await identity(project);
  await host.locator('a[href="/project/0000000002"]').first().click();
  if (!recoveryOnly) {
    const nativeProject = await application.browserWindow(project);
    await expect.poll(() => nativeProject.evaluate((win) => win.isFocused())).toBe(true);
  }
  assert.equal(application.windows().length, 3);
  await measure('host-project-and-pane', pane);

  const hostClosed = host.waitForEvent('close');
  await host.evaluate(() => window.puddleDesktop.closeWindow());
  await hostClosed;
  assert.deepEqual(await application.evaluate(() => globalThis.nativePreviewConnections), {
    starts: 1,
    closes: 0,
  });
  await dirtyEditor(pane);
  if (!recoveryOnly) {
    const nativePane = await application.browserWindow(pane);
    await changeFullScreen(nativePane, true);
    assert.equal(await nativePane.evaluate((win) => win.isFullScreen()), true);
    await changeFullScreen(nativePane, false);
    assert.equal(await nativePane.evaluate((win) => win.isFullScreen()), false);
    console.log(
      'Native project routing/focus, independent host closure and pane fullscreen passed.',
    );
  } else
    console.log('Independent host closure passed; focus/fullscreen omitted in recovery-only mode.');
  await pane.evaluate(() => window.puddleDesktop.closeWindow());
  await expect(pane.getByRole('dialog')).toContainText('Discard changes to README.md?');
  await pane.evaluate(() => window.puddleDesktop.closeWindow());
  await expect(pane.getByRole('dialog')).toHaveCount(1);
  // App quit must checkpoint the dirty draft rather than treating review as consent.
  await quit();
  const retained = (await state()).windows.map((record) => record.window.id).sort();
  assert.deepEqual(retained, [paneIdentity.identity.id, projectIdentity.identity.id].sort());

  await launch();
  await expect.poll(() => application.windows().length).toBe(2);
  const restored = await Promise.all(
    application.windows().map(async (page) => {
      await page.waitForFunction(() => !!window.puddleDesktop);
      return { page, context: await identity(page) };
    }),
  );
  assert.deepEqual(restored.map(({ context }) => context.identity.id).sort(), retained);
  const restoredPane = restored.find(({ context }) => context.identity.kind === 'pane').page;
  await dirtyEditor(restoredPane);
  assert.deepEqual(await application.evaluate(() => globalThis.nativePreviewConnections), {
    starts: 1,
    closes: 0,
  });
  console.log(
    'Native app quit/relaunch restored project/pane-only identities and dirty text with one connection.',
  );
  const crashedPane = await application.browserWindow(restoredPane);
  await crashedPane.evaluate((win) => win.webContents.forcefullyCrashRenderer());
  await expect.poll(() => crashedPane.evaluate((win) => win.webContents.isCrashed())).toBe(true);
  const nativeId = await crashedPane.evaluate((win) => win.id);
  await Promise.all([
    restoredPane.waitForEvent('domcontentloaded'),
    application.evaluate(({ Menu, BrowserWindow }, id) => {
      const reload = Menu.getApplicationMenu()
        .items.flatMap((item) => item.submenu?.items ?? [])
        .find((item) => item.label === 'Reload');
      if (!reload) throw new Error('Native Reload menu is missing');
      reload.click(reload, BrowserWindow.fromId(id), {});
    }, nativeId),
  ]);
  // Playwright keeps the old Page's crashed flag even after Electron reloads it.
  // Observe the actual replacement renderer through its surviving native window.
  await expect
    .poll(
      () =>
        crashedPane.evaluate(async (win) => {
          try {
            return await win.webContents.executeJavaScript(`(async () => {
        const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
        return monaco.editor.getEditors().map(editor => editor.getModel()?.getValue());
      })()`);
          } catch {
            return [];
          }
        }),
      { timeout: 30_000 },
    )
    .toContain(dirtyText);
  const recoveredContext = await crashedPane.evaluate((win) =>
    win.webContents.executeJavaScript('window.puddleDesktop.windows.context()'),
  );
  assert.equal(recoveredContext.identity.id, paneIdentity.identity.id);
  console.log(
    'Native renderer crash and actual Reload menu recovered the same pane and dirty draft.',
  );

  const interrupted = application.waitForEvent('close');
  application.process().kill('SIGKILL');
  await interrupted;
  application = undefined;
  await launch();
  await expect.poll(() => application.windows().length).toBe(2);
  const afterInterruption = await Promise.all(
    application.windows().map(async (page) => {
      await page.waitForFunction(() => !!window.puddleDesktop);
      return { page, context: await identity(page) };
    }),
  );
  assert.deepEqual(afterInterruption.map(({ context }) => context.identity.id).sort(), retained);
  const lastPane = afterInterruption.find(({ context }) => context.identity.kind === 'pane').page;
  const lastProject = afterInterruption.find(
    ({ context }) => context.identity.kind === 'project',
  ).page;
  await dirtyEditor(lastPane);
  await checkMissingResources(application, lastPane, expect, dirtyText);
  await Promise.all([
    lastProject.waitForEvent('close'),
    lastProject.evaluate(() => window.puddleDesktop.closeWindow()),
  ]);
  const returned = (await state()).entries[projectIdentity.identity.id];
  assert.equal(returned.open, false);
  assert.equal(returned.returnedProject, true);
  assert.equal(application.windows().length, 1);
  await dirtyEditor(lastPane);
  console.log(
    'Native forced interruption recovered both windows; explicit project close returned its workspace without a host.',
  );
  // Even a renderer that skips review cannot bypass main's final dirty-state guard.
  await lastPane.evaluate(() => window.puddleDesktop.windows.lifecycle.closeReviewedPane());
  await expect(lastPane.getByRole('dialog')).toContainText('Discard changes to README.md?');
  await lastPane.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(lastPane.getByRole('dialog')).toHaveCount(0);
  await dirtyEditor(lastPane);
  await prepareUntitledClose(lastPane, expect);
  await lastPane.evaluate(() => window.puddleDesktop.closeWindow());
  await expect(lastPane.getByRole('dialog')).toContainText('Discard changes to README.md?');
  const lastClosed = application.waitForEvent('close');
  await lastPane.getByRole('button', { name: 'Discard', exact: true }).click();
  await finishUntitledClose(lastPane, expect);
  await lastClosed;
  application = undefined;
  const closedPane = (await state()).entries[paneIdentity.identity.id];
  assert.equal(closedPane.open, false);
  assert.deepEqual(closedPane.workspaces[paneIdentity.identity.profileId].content.buffers, []);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, 'home/native-preview-connections.json'))),
    { starts: 1, closes: 1 },
  );
  console.log(
    'Native pane close reviews dirty files, retains cancellation, rejects bypass and preserves drafts when quitting during review.',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      result: 'passed',
      omitted: recoveryOnly ? ['native focus', 'fullscreen'] : [],
    }),
  );
} catch (error) {
  if (application)
    for (const page of application.windows())
      console.error(
        'Native window at failure:',
        page.url(),
        await page
          .locator('body')
          .innerText()
          .catch(() => 'unavailable'),
      );
  throw error;
} finally {
  if (application) await application.close().catch(() => application.process().kill('SIGKILL'));
  await rm(directory, { recursive: true, force: true });
}
