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
import { checkWindowEffects, checkDetachedEffectOwner } from './windows/effects/coordination.mjs';
import { checkCatalogueLayouts } from './windows/arrangements/catalogue.mjs';
import { checkArrangementHandshake } from './windows/arrangements/handshake.mjs';
import { checkArrangementApply, checkArrangementMode } from './windows/arrangements/apply.mjs';
import { checkHuddleRecovery } from './windows/recovery/huddle.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'puddle-live-window-'));
const implementation = join(directory, 'implementation.mjs');
await build({
  stdin: {
    contents: `export { DesktopWindowState } from ${JSON.stringify(resolve(root, 'packages/desktop/src/windows/persistence/state.ts'))};\nexport { WindowTransfers } from ${JSON.stringify(resolve(root, 'packages/desktop/src/windows/transfers/coordinator.ts'))};\nexport { WindowCommands } from ${JSON.stringify(resolve(root, 'packages/desktop/src/windows/lifecycle/commands.ts'))};\nexport { WindowDrags } from ${JSON.stringify(resolve(root, 'packages/desktop/src/windows/transfers/drags.ts'))};\nexport { ProjectWindows } from ${JSON.stringify(resolve(root, 'packages/desktop/src/windows/projects.ts'))};\nexport { WindowLayoutApply } from ${JSON.stringify(resolve(root, 'packages/desktop/src/windows/arrangements/apply.ts'))};\nexport { WindowLayoutCapture } from ${JSON.stringify(resolve(root, 'packages/desktop/src/windows/arrangements/capture.ts'))};\nexport { WindowEffects } from ${JSON.stringify(resolve(root, 'packages/desktop/src/windows/effects/coordination.ts'))};`,
    resolveDir: root,
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: implementation,
  alias: { '@puddle/shared': resolve(root, 'packages/shared/src/index.ts') },
});
const {
  DesktopWindowState,
  WindowTransfers,
  WindowCommands,
  WindowDrags,
  ProjectWindows,
  WindowLayoutApply,
  WindowLayoutCapture,
  WindowEffects,
} = await import(pathToFileURL(implementation).href);
const commands = new WindowCommands();
const mode = process.env.WINDOW_TRANSFER_KIND ?? 'pane';
const dragBack = process.env.WINDOW_DOCK_BACK === 'drag';
const dockBack = process.env.WINDOW_DOCK_BACK === '1' || dragBack;
const addTab = process.env.WINDOW_ADD_TAB;
assert.ok(['pane', 'file', 'session', 'project'].includes(mode));
let focused = 0;
const state = new DesktopWindowState(join(directory, 'windows.json'));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const records = new Map();
const pages = new Map();
const errors = [];
const trace = [];
let effectFocus = 'host';
const effects = new WindowEffects(
  () =>
    [...records.values()]
      .filter(
        (record) =>
          !pages.get(record.window.id)?.isClosed() && commands.available(record.window.id),
      )
      .map((record) => ({
        id: record.window.id,
        host: record.target,
        kind: record.window.kind,
        focused: record.window.id === effectFocus,
      })),
  (id, status) => {
    void pages
      .get(id)
      ?.evaluate(
        (value) => window.windowEffectsListeners?.forEach((listener) => listener(value)),
        status,
      )
      .catch(() => {});
  },
);

const drags = new WindowDrags({
  context: (id) => {
    const record = records.get(id);
    if (!record) throw new Error('Window unavailable');
    return {
      identity: record.window,
      hostId: 'host',
      stagingTransfer: state.staging(id)?.id,
      stagingArrangement: state.stagingArrangement(id)?.transaction.id,
    };
  },
  move: (id, command) => commands.moveContent(id, command),
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
const pendingProjectCommands = new Map();
const projects = new ProjectWindows({
  state: () => state,
  transfers: coordinator,
  record: (id) => {
    const record = records.get(id);
    if (!record) throw new Error('Window unavailable');
    return record;
  },
  open: openPage,
  raise: () => {
    focused++;
  },
  command: async (id, command) => {
    if (commands.available(id)) await commands.project(id, command);
    else pendingProjectCommands.set(id, command);
  },
});

let layoutQueue = Promise.resolve();
const runLayout = (_target, _key, action) => {
  const operation = layoutQueue.then(action);
  layoutQueue = operation.catch(() => {});
  return operation;
};
const captures = new WindowLayoutCapture({
  state: () => state,
  record: (id) => records.get(id),
  run: runLayout,
  validate: (ids) => {
    for (const id of ids) if (!commands.available(id)) throw new Error('Renderer unavailable');
  },
  checkpoint: (id) => commands.request(id, 'checkpoint'),
  resume: (ids) => Promise.all(ids.map((id) => commands.request(id, 'resume'))),
});
const layouts = new WindowLayoutApply({
  state: () => state,
  admit: (id) => records.get(id),
  record: (id) => ({ ...records.get(id), route: new URL(pages.get(id).url()).pathname }),
  run: runLayout,
  validate: (ids) => {
    for (const id of ids) if (!commands.available(id)) throw new Error('Renderer unavailable');
  },
  generation: (id) => commands.generation(id),
  ready: (id) => commands.whenReady(id),
  command: (id, command) => commands.arrangement(id, command),
  plan: (id, command) => commands.planArrangement(id, command),
  open: openPage,
  dismiss: (id) => {
    records.delete(id);
    commands.disconnected(id);
    void pages.get(id)?.close();
    const open = new Set(state.openWindows().map((record) => record.window.id));
    state.syncOpenWindows([...records.values()].filter((record) => open.has(record.window.id)));
  },
  reload: async (id) => {
    await pages.get(id).reload();
  },
  committed: () => {},
  report: (error) => errors.push(error.message),
});

async function closePage(id) {
  await commands.request(id, 'checkpoint');
  const record = records.get(id);
  if (record.window.kind === 'project')
    state.closeProject(id, state.read(id, record.window.profileId).revision);
  records.delete(id);
  state.syncOpenWindows([...records.values()]);
  commands.disconnected(id);
  await pages.get(id).close();
}

async function openPage(record) {
  const id = record.window.id;
  if (pages.has(id) && !pages.get(id).isClosed()) return;
  records.set(id, record);
  state.syncOpenWindows([...records.values()]);
  const page = await context.newPage();
  pages.set(id, page);
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      commands.disconnected(id);
  });
  page.on('close', () => {
    commands.disconnected(id);
    effects.publish();
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.exposeBinding('windowRequest', async (_source, method, request) => {
    if (method === 'effects-status') return effects.status(id);
    if (method === 'effects-claim') return effects.claimNotification(id, request);
    if (method === 'effects-focus') {
      effectFocus = id;
      return;
    }
    if (method === 'context')
      return {
        identity: record.window,
        hostId: 'host',
        stagingTransfer: state.staging(id)?.id,
        stagingArrangement: state.stagingArrangement(id)?.transaction.id,
      };
    if (method === 'ready') {
      commands.ready(id, (command) => {
        void page
          .evaluate((value) => window.receiveWindowCommand(value), command)
          .catch((error) => {
            commands.disconnected(id);
            errors.push(error.message);
          });
      });
      effects.publish();
      const command = pendingProjectCommands.get(id);
      if (command) {
        pendingProjectCommands.delete(id);
        void commands.project(id, command);
      }
      return;
    }
    if (method === 'close') {
      void closePage(id).catch((error) => errors.push(error.message));
      return;
    }
    if (method.startsWith('project-'))
      return projects[method.slice('project-'.length)](id, request);
    if (method === 'reply') {
      if (request.error) trace.push([id, request.error]);
      return commands.reply(id, request);
    }
    if (method === 'layout-capture') return captures.capture(id, request);
    if (method === 'layout-apply') return layouts.apply(id, request);
    if (method === 'layout-observe') return layouts.observe(id, request);
    if (method === 'beginPaneDrag') return drags.beginPane(id, request);
    if (method === 'dropPane') return drags.dropPane(id, request);
    if (method === 'beginTabDrag') return drags.beginTab(id, request);
    if (method === 'dropTab') return drags.dropTab(id, request);
    if (method === 'beginProjectDrag') return drags.beginProject(id, request);
    if (method === 'dropProject') return drags.dropProject(id, request);
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
  await page.addInitScript(
    ({ mode, effectsCheck }) => {
      window.notificationDeliveries = [];
      window.notificationSounds = 0;
      const Audio = window.AudioContext;
      window.AudioContext = class extends Audio {
        constructor(...args) {
          super(...args);
          window.notificationSounds++;
        }
      };
      window.puddleDesktop = {
        raiseWindow() {},
        updateReady: async () => (effectsCheck ? '0.4.999' : null),
        onUpdateReady: () => {
          window.desktopUpdateObservers = (window.desktopUpdateObservers ?? 0) + 1;
          return () => {
            window.desktopUpdateObservers--;
          };
        },
        notificationTargets: true,
        notificationStatus: async () => ({ state: 'shown', message: null }),
        showNotification: async (request) => {
          window.notificationDeliveries.push(request);
          return { state: 'shown', message: null };
        },
        onNotificationClick: (callback) => {
          window.notificationClickListeners ??= new Set();
          window.notificationClickListeners.add(callback);
          window.notificationClick = (...args) =>
            window.notificationClickListeners.forEach((listener) => listener(...args));
          return () => window.notificationClickListeners.delete(callback);
        },
        closeWindow: () => window.windowRequest('close'),
        isFullScreen: async () => false,
        windows: {
          version: 1,
          effects: {
            status: () => window.windowRequest('effects-status'),
            claimNotification: (request) => window.windowRequest('effects-claim', request),
            onChanged: (callback) => {
              window.windowEffectsListeners ??= new Set();
              window.windowEffectsListeners.add(callback);
              return () => window.windowEffectsListeners.delete(callback);
            },
          },
          layouts: Object.fromEntries(
            ['capture', 'apply', 'observe'].map((method) => [
              method,
              (request) => window.windowRequest(`layout-${method}`, request),
            ]),
          ),
          projects: Object.fromEntries(
            ['prepare', 'focus', 'route'].map((method) => [
              method,
              (request) => window.windowRequest(`project-${method}`, request),
            ]),
          ),
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
                  layout_mode: 'project',
                  project_layouts: {
                    [sessions[0].project_id]: {
                      layout_tree: {
                        kind: 'leaf',
                        id: 'fixture-pane',
                        tabs: [ref],
                        activeKey: tabRefKey(ref),
                        previewKey: null,
                      },
                      active_session: null,
                      layout_ref: null,
                    },
                  },
                  explorer_pin: sessions[0].id,
                  layout_tree: null,
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
              'beginTabDrag',
              'dropTab',
              'prepareTabDock',
              'beginProjectDrag',
              'dropProject',
              'prepareProjectDock',
              'accept',
              'commit',
              'observe',
              'cancel',
              'focusPane',
            ].map((method) => [method, (request) => window.windowRequest(method, request)]),
          ),
        },
      };
    },
    { mode, effectsCheck: process.env.WINDOW_EFFECTS === '1' },
  );
  await page.goto(new URL(record.route ?? '/', preview).href);
}

try {
  await openPage({ target: 'local', window: { id: 'host', kind: 'host' } });
  const source = pages.get('host');
  await source
    .locator(mode === 'session' ? '.xterm' : '[data-editor-surface] .monaco-editor')
    .first()
    .waitFor();
  const closeNotes = source
    .locator('[data-release-notes]')
    .getByRole('button', { name: 'Close', exact: true });
  await closeNotes.click();
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
    mode === 'project'
      ? source.locator('a[href="/project/0000000002"]').first()
      : mode === 'file'
        ? source.locator('[data-path="README.md"]').first()
        : mode === 'session'
          ? source.locator('[data-pane-tab]').first()
          : source.locator('[data-pane-drag-handle]').first();
  if (mode === 'project') {
    await source.evaluate(async () =>
      (await import('/src/features/windows/navigation/project-actions.ts')).navigateProjectRoute(
        '/',
      ),
    );
    await trigger.waitFor();
  }
  await trigger.dispatchEvent('contextmenu', { button: 2 });
  await source.getByRole('menuitem', { name: `Open ${mode} in window`, exact: true }).click();
  await expect
    .poll(
      () =>
        [...records.values()].filter(
          (record) => record.window.kind === (mode === 'project' ? 'project' : 'pane'),
        ).length,
    )
    .toBe(1);
  const destination = [...records.values()].find(
    (record) => record.window.kind === (mode === 'project' ? 'project' : 'pane'),
  );
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
  if (process.env.WINDOW_EFFECTS === '1')
    await checkWindowEffects({ source, target, profileId: profile, focused: () => focused });
  if (process.env.WINDOW_LAYOUT_CATALOGUE === '1')
    await checkCatalogueLayouts({
      state,
      source,
      pages,
      records,
      profileId: profile,
      targetId: destination.window.id,
      checkText,
    });
  if (process.env.WINDOW_LAYOUT_HANDSHAKE === '1')
    await checkArrangementHandshake({
      state,
      commands,
      records,
      pages,
      openPage,
      profileId: profile,
      targetId: destination.window.id,
      checkText,
    });
  if (process.env.WINDOW_LAYOUT_APPLY === '1')
    await checkArrangementApply({
      state,
      source,
      records,
      pages,
      profileId: profile,
      targetId: destination.window.id,
      checkText,
    });
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
  if (mode === 'project') {
    await expect(target.locator('[data-path="README.md"]').first()).toBeVisible();
    await trigger.click();
    await expect.poll(() => focused).toBeGreaterThan(0);
    assert.equal(new URL(source.url()).pathname, '/');
    assert.equal(records.size, 2);
    // An unmediated history/deep-link visit must also focus the dedicated owner.
    await source.evaluate(() => {
      window.history.pushState(null, '', '/project/0000000002');
      window.dispatchEvent(new window.PopStateEvent('popstate'));
    });
    await expect.poll(() => new URL(source.url()).pathname).toBe('/');
    await source.evaluate(
      async (profileId) =>
        window.puddleDesktop.windows.projects.route({
          profileId,
          route: '/project/0000000002/session/00000000-0000-4000-8000-000000000001',
        }),
      profile,
    );
    await target.locator('.xterm').first().waitFor();
    await target
      .locator('[data-pane-tab]')
      .filter({ hasText: 'README.md' })
      .first()
      .click({ position: { x: 10, y: 12 } });
    await target.locator('[data-editor-surface] .monaco-editor').first().waitFor();
    await Promise.all([
      target.waitForEvent('load'),
      target.evaluate(() => {
        void window.puddleDesktop.windows.reload();
      }),
    ]);
    await checkText(target);
    if (dockBack) {
      if (dragBack) {
        const payload = await target.evaluate(() => {
          const label = window.document.querySelector(
            '[data-sidebar-motion="sessions-project-0000000002"]',
          );
          const data = new window.DataTransfer();
          label.dispatchEvent(
            new window.DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
          );
          return data.getData('application/x-puddle-project-window');
        });
        assert.ok(payload, 'project label registers a native window drag');
        assert.ok(!payload.includes('Unsaved text'));
        const drop = async (type) =>
          source.locator('[data-project-window-drop-target]').evaluate(
            (element, { payload, type }) => {
              const data = new window.DataTransfer();
              data.setData('application/x-puddle-project-window', payload);
              element.dispatchEvent(
                new window.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }),
              );
            },
            { payload, type },
          );
        await drop('dragenter');
        await expect(
          source.getByRole('status').filter({ hasText: 'Return project here' }),
        ).toBeVisible();
        await expect(source.getByText('Return project here')).toHaveCount(0);
        await drop('drop');
      } else {
        await target
          .locator('[data-sidebar-motion="sessions-project-0000000002"]')
          .first()
          .dispatchEvent('contextmenu', { button: 2 });
        await target.getByRole('menuitem', { name: 'Return project to host', exact: true }).click();
      }
      await expect.poll(() => target.isClosed()).toBe(true);
      await checkText(source);
      assert.equal(state.projectWindow('host', profile, destination.window.projectId), null);
      assert.equal(state.openWindows().length, 1);
      assert.equal(new URL(source.url()).pathname.split('/session/')[0], '/project/0000000002');
      await source.reload();
      await checkText(source);
      await source.screenshot({ path: '/tmp/puddle-live-project-docking.png' });
      assert.deepEqual(errors, []);
      console.log(
        `Project ${dragBack ? 'drag' : 'menu'} return, atomic source closure and host reload pass.`,
      );
    } else {
      await closePage('host');
      const latest = 'Project draft after the host window closed';
      await target.evaluate(async (text) => {
        const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
        const editor = monaco.editor
          .getEditors()
          .find((editor) => editor.getModel()?.uri.scheme === 'puddle');
        editor.getModel().setValue(text);
      }, latest);
      await target
        .locator('[data-sidebar-motion="sessions-project-0000000002"]')
        .first()
        .dispatchEvent('contextmenu', { button: 2 });
      await target.getByRole('menuitem', { name: 'Return project to host', exact: true }).click();
      await expect.poll(() => target.isClosed()).toBe(true);
      assert.equal(records.size, 0);
      assert.ok(state.returnedProject(destination.window.id));
      await openPage({
        target: 'local',
        window: { id: 'host', kind: 'host' },
        route: '/project/0000000002',
      });
      const returned = pages.get('host');
      await returned.waitForFunction(async (expected) => {
        const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
        return monaco.editor
          .getEditors()
          .some((editor) => editor.getModel()?.getValue() === expected);
      }, latest);
      await expect.poll(() => state.returnedProject(destination.window.id)).toBeNull();
      await returned.screenshot({ path: '/tmp/puddle-live-project-return.png' });
      assert.deepEqual(errors, []);
      console.log(
        'Project menu, click/history redirect, independent closure and host return pass.',
      );
    }
  } else if (addTab) {
    assert.equal(mode, 'pane');
    assert.ok(['file', 'tab', 'session'].includes(addTab));
    const secondText = 'Another dirty document brought into the pane';
    if (addTab !== 'session') {
      await source.locator('[data-path="package.json"]').first().dblclick();
      await source.locator('[data-editor-surface] .monaco-editor').waitFor();
      await source.evaluate(async (text) => {
        const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
        const editor = monaco.editor
          .getEditors()
          .find((editor) => editor.getModel()?.uri.path.endsWith('/package.json'));
        editor.getModel().setValue(text);
        editor.setSelection({
          startLineNumber: 1,
          startColumn: 3,
          endLineNumber: 1,
          endColumn: 10,
        });
      }, secondText);
    }
    const payload = await source.evaluate(async (addTab) => {
      const data = new window.DataTransfer();
      const row =
        addTab === 'tab'
          ? window.document.querySelector('[data-pane-tab]')
          : addTab === 'file'
            ? window.document.querySelector('[data-path="package.json"]')
            : window.document.querySelector('[data-session-project] li[draggable="true"]');
      row.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
      row.dispatchEvent(new window.DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
      return data.getData('application/x-puddle-tab');
    }, addTab);
    assert.ok(payload, 'sidebar drag carries a registered tab reference');
    assert.ok(!payload.includes(secondText));
    await target
      .locator('[data-pane-drag-handle]')
      .first()
      .evaluate((strip, payload) => {
        const data = new window.DataTransfer();
        data.setData('application/x-puddle-tab', payload);
        strip.dispatchEvent(
          new window.DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }),
        );
      }, payload);
    await expect(target.locator('[data-pane-tab]')).toHaveCount(2);
    await expect.poll(() => state.openWindows().length).toBe(2);
    const transferred = state.read(destination.window.id, profile).content;
    assert.equal(transferred.snapshot.layout_tree.kind, 'leaf');
    assert.equal(transferred.snapshot.layout_tree.tabs.length, 2);
    assert.equal(
      transferred.buffers.find((buffer) => buffer.path === 'README.md').content,
      'Unsaved text moved through the real coordinator',
    );
    if (addTab !== 'session') {
      await checkText(target, secondText, 3, 10);
      assert.equal(
        transferred.buffers.find((buffer) => buffer.path === 'package.json').content,
        secondText,
      );
      assert.ok(
        !JSON.stringify(state.read('host', profile).content.snapshot).includes('package.json'),
      );
    } else {
      assert.equal(
        transferred.snapshot.layout_tree.tabs.find((tab) => tab.type === 'terminal').session,
        JSON.parse(payload).ref.session,
      );
      await target.locator('.xterm').first().waitFor();
    }
    await target.reload();
    await expect(target.locator('[data-pane-tab]')).toHaveCount(2);
    if (addTab !== 'session') await checkText(target, secondText, 3, 10);
    else await target.locator('.xterm').first().waitFor();
    if (addTab === 'tab') {
      // Real Chromium native mouse dragging within one renderer must MOVE the
      // exact tab, preserving the other file instead of copying or flattening.
      const body = target.locator('[data-pane-drop-target]').first();
      const box = await body.boundingBox();
      await target
        .locator('[data-pane-tab]')
        .last()
        .dragTo(body, {
          sourcePosition: { x: 20, y: 12 },
          targetPosition: { x: box.width - 10, y: box.height / 2 },
        });
      await expect(target.locator('[data-pane-drop-target]')).toHaveCount(2);
      await expect(target.locator('[data-pane-tab]')).toHaveCount(2);
      await checkText(target, secondText, 3, 10);
    }
    await target.screenshot({ path: `/tmp/puddle-live-window-add-${addTab}.png` });
    assert.deepEqual(errors, []);
    console.log(`Live ${addTab} drop into an existing pane strip preserves both tabs and reloads.`);
  } else if (dockBack) {
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
    if (process.env.WINDOW_EFFECTS === '1') await checkDetachedEffectOwner(target);
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
  if (process.env.WINDOW_LAYOUT_APPLY === '1' && mode === 'project' && dockBack)
    await checkArrangementMode({ state, source, profileId: profile, checkText });
  if (process.env.WINDOW_HUDDLE_RECOVERY === '1') {
    await checkHuddleRecovery(target, profile);
    assert.deepEqual(errors, []);
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
