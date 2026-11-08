/* global window */
// Exercise real renderer components against the desktop transfer coordinator,
// using isolated Chromium pages and UI preview data. No daemon or host connection.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'puddle-live-window-'));
const implementation = join(directory, 'implementation.mjs');
await build({
  stdin: {
    contents: `export { DesktopWindowState } from ${JSON.stringify(resolve(root, 'packages/desktop/src/windows/state.ts'))};\nexport { WindowTransfers } from ${JSON.stringify(resolve(root, 'packages/desktop/src/windows/transfers.ts'))};`,
    resolveDir: root,
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: implementation,
  alias: { '@puddle/shared': resolve(root, 'packages/shared/src/index.ts') },
});
const { DesktopWindowState, WindowTransfers } = await import(pathToFileURL(implementation).href);
const state = new DesktopWindowState(join(directory, 'windows.json'));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const records = new Map();
const pages = new Map();
const errors = [];
const preview = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5186/';
const coordinator = new WindowTransfers({
  state: () => state,
  record: (id) => records.get(id),
  open: openPage,
  dismiss: (id) => {
    records.delete(id);
    void pages.get(id)?.close();
    state.syncOpenWindows([...records.values()]);
  },
  report: (error) => errors.push(error.message),
});

async function openPage(record) {
  const id = record.window.id;
  records.set(id, record);
  state.syncOpenWindows([...records.values()]);
  const page = await context.newPage();
  pages.set(id, page);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.exposeBinding('windowRequest', async (_source, method, request) => {
    if (method === 'context')
      return { identity: record.window, hostId: 'host', stagingTransfer: state.staging(id)?.id };
    if (method === 'read') return state.readPresentation(id, request);
    if (method === 'write' || method === 'seed')
      return state.write(id, request.profileId, request.revision, request.content);
    if (method === 'preparePane') return coordinator.preparePane(id, request);
    return coordinator[method](id, request);
  });
  await page.addInitScript(() => {
    window.puddleDesktop = {
      raiseWindow() {},
      isFullScreen: async () => false,
      windows: {
        version: 1,
        context: () => window.windowRequest('context'),
        read: async (profileId) => {
          const existing = await window.windowRequest('read', profileId);
          if (existing) return existing;
          const { state, sessions } = await import('/src/dev/preview/data.ts');
          const { tabRefKey } = await import('/src/features/workspace/layout/layout-tree.ts');
          const ref = {
            type: 'editor',
            tab: { session: sessions[0].id, path: 'README.md', view: 'source' },
          };
          return window.windowRequest('seed', {
            profileId,
            revision: 0,
            content: {
              snapshot: {
                ...state.ui_state,
                layout_mode: 'profile',
                project_layouts: {},
                explorer_pin: sessions[0].id,
                layout_tree: {
                  kind: 'leaf',
                  id: 'fixture-pane',
                  tabs: [ref],
                  activeKey: tabRefKey(ref),
                  previewKey: null,
                },
              },
              buffers: [],
              views: {},
            },
          });
        },
        write: (request) => window.windowRequest('write', request),
        transfers: Object.fromEntries(
          ['preparePane', 'accept', 'commit', 'observe', 'cancel'].map((method) => [
            method,
            (request) => window.windowRequest(method, request),
          ]),
        ),
      },
    };
  });
  await page.goto(new URL(record.route ?? '/', preview).href);
}

try {
  await openPage({ target: 'local', window: { id: 'host', kind: 'host' } });
  const source = pages.get('host');
  await source.locator('[data-editor-surface] .monaco-editor').waitFor();
  const closeNotes = source.getByRole('button', { name: 'Close', exact: true });
  if (await closeNotes.isVisible().catch(() => false)) await closeNotes.click();
  await source.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    monaco.editor
      .getModels()
      .find((model) => model.uri.scheme === 'puddle')
      .setValue('Unsaved text moved through the real coordinator');
  });
  await source
    .locator('[data-pane-drag-handle]')
    .first()
    .dispatchEvent('contextmenu', { button: 2 });
  await source.getByRole('menuitem', { name: 'Open pane in window', exact: true }).click();
  await expect
    .poll(() => [...records.values()].filter((record) => record.window.kind === 'pane').length)
    .toBe(1);
  const destination = [...records.values()].find((record) => record.window.kind === 'pane');
  await expect.poll(() => pages.has(destination.window.id)).toBe(true);
  const target = pages.get(destination.window.id);
  const checkText = async (page) => {
    await page.locator('[data-editor-surface] .monaco-editor').waitFor();
    await page.waitForFunction(async () => {
      const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
      return monaco.editor
        .getModels()
        .some((model) => model.getValue() === 'Unsaved text moved through the real coordinator');
    });
  };
  await checkText(target);
  await expect.poll(() => state.openWindows().length).toBe(2);
  await expect(source.locator('[data-editor-surface] .monaco-editor')).toHaveCount(0);
  await expect(target.getByRole('group', { name: 'Workspace controls' })).toHaveCount(0);
  const profile = destination.window.profileId;
  assert.equal(state.read('host', profile).content.buffers.length, 0);
  assert.equal(
    state.read(destination.window.id, profile).content.buffers[0].content,
    'Unsaved text moved through the real coordinator',
  );
  records.delete('host');
  state.syncOpenWindows([...records.values()]);
  await source.close();
  await target.reload();
  await checkText(target);
  await target.screenshot({ path: '/tmp/puddle-live-pane-transfer.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Live pane handoff, source retirement, dirty text, and independent pane reload pass.',
  );
} finally {
  await browser.close();
  await rm(directory, { recursive: true, force: true });
}
