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
    contents: `export { DesktopWindowState } from ${JSON.stringify(resolve(root, 'packages/desktop/src/windows/state.ts'))};\nexport { WindowTransfers } from ${JSON.stringify(resolve(root, 'packages/desktop/src/windows/transfers.ts'))};\nexport { WindowCommands } from ${JSON.stringify(resolve(root, 'packages/desktop/src/windows/commands.ts'))};\nexport { PaneDrags } from ${JSON.stringify(resolve(root, 'packages/desktop/src/windows/drags.ts'))};`,
    resolveDir: root,
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: implementation,
  alias: { '@puddle/shared': resolve(root, 'packages/shared/src/index.ts') },
});
const { DesktopWindowState, WindowTransfers, WindowCommands, PaneDrags } = await import(
  pathToFileURL(implementation).href
);
const commands = new WindowCommands();
const mode = process.env.WINDOW_TRANSFER_KIND ?? 'pane';
const dragBack = process.env.WINDOW_DOCK_BACK === 'drag';
const dockBack = process.env.WINDOW_DOCK_BACK === '1' || dragBack;
assert.ok(['pane', 'file', 'session'].includes(mode));
let focused = 0;
const state = new DesktopWindowState(join(directory, 'windows.json'));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const records = new Map();
const pages = new Map();
const errors = [];
const trace = [];
const drags = new PaneDrags({
  context: (id) => {
    const record = records.get(id);
    if (!record) throw new Error('Window unavailable');
    return { identity: record.window, hostId: 'host', stagingTransfer: state.staging(id)?.id };
  },
  move: (id, command) => commands.movePane(id, command),
});
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
  command: (id, command) => {
    trace.push([id, command.kind]);
    return commands.transfer(id, command);
  },
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
    if (method === 'ready')
      return commands.ready(id, (command) => {
        void page.evaluate((value) => window.receiveWindowCommand(value), command);
      });
    if (method === 'reply') {
      if (request.error) trace.push([id, request.error]);
      return commands.reply(id, request);
    }
    if (method === 'beginPaneDrag') return drags.begin(id, request);
    if (method === 'dropPane') return drags.drop(id, request);
    if (method === 'reload') {
      await commands.request(id, 'checkpoint');
      await page.reload();
      return;
    }
    if (method === 'focusPane') {
      const target = state.findPane(id, request.profileId, request.ref);
      if (!target || !pages.has(target)) return false;
      focused++;
      await pages.get(target).bringToFront();
      await commands.request(target, 'activate-tab', request);
      return true;
    }
    if (method === 'dockTargets')
      return [...records.values()]
        .filter((candidate) => candidate.window.id !== id && candidate.window.kind === 'host')
        .map((candidate) => ({ identity: candidate.window, label: 'Host window' }));
    if (method === 'read') return state.readPresentation(id, request);
    if (method === 'write' || method === 'seed')
      return state.write(id, request.profileId, request.revision, request.content);
    if (method === 'preparePane') return coordinator.preparePane(id, request);
    return coordinator[method](id, request);
  });
  await page.addInitScript((mode) => {
    window.puddleDesktop = {
      raiseWindow() {},
      isFullScreen: async () => false,
      windows: {
        version: 1,
        lifecycle: {
          ready: () => window.windowRequest('ready'),
          onCommand: (callback) => {
            window.receiveWindowCommand = callback;
            return () => {};
          },
          reply: (request) => window.windowRequest('reply', request),
        },
        context: () => window.windowRequest('context'),
        reload: () => window.windowRequest('reload'),
        read: async (profileId) => {
          const existing = await window.windowRequest('read', profileId);
          if (existing) return existing;
          const { state, sessions } = await import('/src/dev/preview/data.ts');
          const { tabRefKey } = await import('/src/features/workspace/layout/layout-tree.ts');
          const ref =
            mode === 'session'
              ? { type: 'terminal', session: sessions[0].id }
              : {
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
          [
            'preparePane',
            'prepareDock',
            'retire',
            'dockTargets',
            'beginPaneDrag',
            'dropPane',
            'accept',
            'commit',
            'observe',
            'cancel',
            'focusPane',
          ].map((method) => [method, (request) => window.windowRequest(method, request)]),
        ),
      },
    };
  }, mode);
  await page.goto(new URL(record.route ?? '/', preview).href);
}

try {
  await openPage({ target: 'local', window: { id: 'host', kind: 'host' } });
  const source = pages.get('host');
  await source
    .locator(mode === 'session' ? '.xterm' : '[data-editor-surface] .monaco-editor')
    .first()
    .waitFor();
  const closeNotes = source.getByRole('button', { name: 'Close', exact: true });
  if (await closeNotes.isVisible().catch(() => false)) await closeNotes.click();
  const sourceProfile = await source.evaluate(
    async () => (await import('/src/dev/preview/data.ts')).profile.id,
  );
  await expect
    .poll(() => state.read('host', sourceProfile)?.content.snapshot.layout_mode)
    .toBe('project');
  if (mode !== 'session')
    await source.evaluate(async () => {
      const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
      const editor = monaco.editor
        .getEditors()
        .find((editor) => editor.getModel()?.uri.scheme === 'puddle');
      editor.getModel().setValue('Unsaved text moved through the real coordinator');
      editor.setSelection({ startLineNumber: 1, startColumn: 9, endLineNumber: 1, endColumn: 18 });
    });
  const trigger =
    mode === 'file'
      ? source.locator('[data-path="README.md"]').first()
      : mode === 'session'
        ? source.locator('[data-pane-tab]').first()
        : source.locator('[data-pane-drag-handle]').first();
  await trigger.dispatchEvent('contextmenu', { button: 2 });
  await source.getByRole('menuitem', { name: `Open ${mode} in window`, exact: true }).click();
  await expect
    .poll(() => [...records.values()].filter((record) => record.window.kind === 'pane').length)
    .toBe(1);
  const destination = [...records.values()].find((record) => record.window.kind === 'pane');
  await expect.poll(() => pages.has(destination.window.id)).toBe(true);
  const target = pages.get(destination.window.id);
  const checkText = async (
    page,
    expected = 'Unsaved text moved through the real coordinator',
    start = 9,
    end = 18,
  ) => {
    if (mode === 'session') {
      await page.locator('.xterm').first().waitFor();
      return;
    }
    await page.locator('[data-editor-surface] .monaco-editor').first().waitFor();
    await page.waitForFunction(
      async ({ expected, start, end }) => {
        const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
        return monaco.editor
          .getEditors()
          .some(
            (editor) =>
              editor.getModel()?.getValue() === expected &&
              editor.getSelection()?.startColumn === start &&
              editor.getSelection()?.endColumn === end,
          );
      },
      { expected, start, end },
    );
  };
  await checkText(target);
  await expect.poll(() => state.openWindows().length).toBe(2);
  await expect(source.locator('[data-editor-surface] .monaco-editor')).toHaveCount(0);
  if (mode === 'session') {
    await expect(source.locator('.xterm')).toHaveCount(0);
    const original = await target.evaluate(
      async () => (await import('/src/dev/preview/data.ts')).sessions[0].id,
    );
    const tree = state.read(destination.window.id, destination.window.profileId).content.snapshot
      .layout_tree;
    assert.equal(tree.kind, 'leaf');
    assert.deepEqual(tree.tabs, [{ type: 'terminal', session: original }]);
  }
  await expect(target.getByRole('group', { name: 'Workspace controls' })).toHaveCount(0);
  const profile = destination.window.profileId;
  assert.equal(state.read('host', profile).content.buffers.length, 0);
  if (mode !== 'session')
    assert.equal(
      state.read(destination.window.id, profile).content.buffers[0].content,
      'Unsaved text moved through the real coordinator',
    );
  if (mode === 'file') {
    await source
      .locator('[data-path="README.md"]')
      .first()
      .dispatchEvent('contextmenu', { button: 2 });
    await source.getByRole('menuitem', { name: 'Open file in window', exact: true }).click();
    await expect.poll(() => focused).toBe(1);
    assert.equal(records.size, 2);
  }
  if (dockBack) {
    if (mode !== 'session') {
      // Keep a clean view of the same file mounted in the destination. Docking
      // must rebuild that shared model with the incoming dirty text as well.
      await source.evaluate(async () => {
        const { sessions } = await import('/src/dev/preview/data.ts');
        const { deleteDraft } = await import('/src/lib/persistence/drafts.ts');
        await deleteDraft(sessions[0].id, 'README.md');
      });
      await source.locator('[data-path="README.md"]').first().dblclick();
      await source.locator('[data-editor-surface] .monaco-editor').waitFor();
      await expect.poll(() => state.read('host', profile).content.buffers.length).toBe(0);
      await target.evaluate(async () => {
        const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
        const editor = monaco.editor
          .getEditors()
          .find((editor) => editor.getModel()?.uri.scheme === 'puddle');
        editor.setSelection({
          startLineNumber: 1,
          startColumn: 12,
          endLineNumber: 1,
          endColumn: 22,
        });
      });
    }
    if (dragBack) {
      // Chromium pages cannot share a live OS drag. Exercise the actual source
      // event, registration and destination capture listener with its payload.
      const payload = await target.evaluate(() => {
        const handle = window.document.querySelector('[data-pane-drag-handle]');
        const data = new window.DataTransfer();
        handle.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
        handle.dispatchEvent(
          new window.DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
        );
        return data.getData('application/x-puddle-pane-window');
      });
      assert.ok(payload, 'native drag carries a registered pane reference');
      assert.ok(!payload.includes('Unsaved text'), 'native payload excludes dirty content');
      await source
        .locator('[data-workspace-pane]')
        .first()
        .evaluate((pane, payload) => {
          const body = pane.querySelector('[data-pane-drop-target]');
          const box = body.getBoundingClientRect();
          const data = new window.DataTransfer();
          data.setData('application/x-puddle-pane-window', payload);
          body.dispatchEvent(
            new window.DragEvent('drop', {
              bubbles: true,
              cancelable: true,
              dataTransfer: data,
              clientX: box.right - 10,
              clientY: box.top + box.height / 2,
            }),
          );
        }, payload);
    } else {
      await target
        .locator('[data-pane-drag-handle]')
        .first()
        .dispatchEvent('contextmenu', { button: 2 });
      await target
        .getByRole('menuitem', { name: 'Return pane to Host window', exact: true })
        .click();
    }
    await expect.poll(() => records.size).toBe(1);
    assert.ok(records.has('host'));
    await checkText(source, undefined, 12, 22);
    assert.equal(state.openWindows().length, 1);
    if (mode !== 'session') {
      const restored = state.read('host', profile).content;
      assert.equal(restored.buffers[0].content, 'Unsaved text moved through the real coordinator');
      await expect(source.locator('[data-pane-tab]')).toHaveCount(2);
    }
    await source.reload();
    await checkText(source, undefined, 12, 22);
    await source.screenshot({ path: '/tmp/puddle-live-pane-docking.png' });
    assert.deepEqual(errors, []);
    console.log(
      `Live ${mode} ${dragBack ? 'drag' : 'menu'} return to an existing host, source retirement, and destination reload pass.`,
    );
  } else {
    records.delete('host');
    state.syncOpenWindows([...records.values()]);
    await source.close();
    // Exercise the native reload capability immediately after an edit, before
    // its ordinary 250ms persistence timer can provide accidental coverage.
    const latest = 'Latest unsaved edit checkpointed before native reload';
    await Promise.all([
      target.waitForEvent('load'),
      target.evaluate(
        async ({ latest, mode }) => {
          if (mode !== 'session') {
            const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
            const editor = monaco.editor
              .getEditors()
              .find((editor) => editor.getModel()?.uri.scheme === 'puddle');
            editor.getModel().setValue(latest);
            editor.setSelection({
              startLineNumber: 1,
              startColumn: 9,
              endLineNumber: 1,
              endColumn: 18,
            });
          }
          void window.puddleDesktop.windows.reload();
        },
        { latest, mode },
      ),
    ]);
    await checkText(target, latest);
    await target.screenshot({ path: '/tmp/puddle-live-pane-transfer.png' });
    assert.deepEqual(errors, []);
    console.log(`Live ${mode} handoff, source view removal, and independent pane reload pass.`);
  }
} catch (error) {
  console.error('Transfer diagnostics', trace, errors);
  for (const [id, page] of pages) {
    if (page.isClosed()) continue;
    console.error(id, await page.locator('[data-sonner-toast]').allTextContents());
    await page.screenshot({ path: `/tmp/puddle-transfer-failure-${id}.png` });
  }
  throw error;
} finally {
  await browser.close();
  await rm(directory, { recursive: true, force: true });
}
