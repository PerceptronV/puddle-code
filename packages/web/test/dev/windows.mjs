/* global window, localStorage */
// UI-only window presentations and dirty recovery. Native transfer/lifecycle has
// separate Electron acceptance; this bridge cannot reach or start a daemon.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
try {
  for (const kind of ['host', 'project', 'pane']) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((kind) => {
      const key = `window-fixture-${kind}`;
      window.puddleDesktop = {
        raiseWindow() {},
        isFullScreen: async () => false,
        windows: {
          version: 1,
          context: async () => {
            const { profile, project } = await import('/src/dev/preview/data.ts');
            return {
              hostId: 'fixture-host',
              identity: {
                kind,
                id: kind,
                ...(kind === 'host' ? {} : { profileId: profile.id, projectId: project.id }),
              },
            };
          },
          read: async () => {
            const existing = localStorage.getItem(key);
            if (existing) return JSON.parse(existing);
            const { state, sessions } = await import('/src/dev/preview/data.ts');
            const { tabRefKey } = await import('/src/features/workspace/layout/layout-tree.ts');
            const ref = {
              type: 'editor',
              tab: { session: sessions[0].id, path: 'README.md', view: 'source' },
            };
            const saved = {
              revision: 1,
              content: {
                snapshot: {
                  ...state.ui_state,
                  layout_mode: 'profile',
                  explorer_pin: sessions[0].id,
                  layout_tree: {
                    kind: 'leaf',
                    id: 'fixture-pane',
                    tabs: [ref],
                    activeKey: tabRefKey(ref),
                  },
                },
                buffers: [],
                views: {},
              },
            };
            localStorage.setItem(key, JSON.stringify(saved));
            return saved;
          },
          write: async ({ revision, content }) => {
            const previous = JSON.parse(localStorage.getItem(key));
            if (revision !== previous.revision) throw new Error('Stale fixture revision');
            const next = { revision: revision + 1, content };
            localStorage.setItem(key, JSON.stringify(next));
            return next;
          },
        },
      };
    }, kind);
    await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
    await page.locator('[data-editor-surface] .monaco-editor').waitFor();
    const closeNotes = page.getByRole('button', { name: 'Close', exact: true });
    if (await closeNotes.isVisible().catch(() => false)) await closeNotes.click();
    assert.equal(
      await page.getByRole('group', { name: 'Workspace controls' }).count(),
      kind === 'host' ? 1 : 0,
    );
    assert.equal((await page.locator('[data-path="README.md"]').count()) > 0, kind !== 'pane');
    if (kind === 'pane') {
      assert.equal(await page.locator('.session-hover-list').count(), 0);
      await page.setViewportSize({ width: 600, height: 700 });
      await page.locator('[data-editor-surface] .monaco-editor').waitFor();
      assert.equal(await page.locator('.control-tray-vertical').count(), 0);
    }
    await page.evaluate(async (text) => {
      const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
      const model = monaco.editor.getModels().find((model) => model.uri.scheme === 'puddle');
      if (!model) throw new Error('No editable fixture model');
      model.setValue(text);
    }, `Recovered ${kind} window edits`);
    await page.waitForFunction(
      (kind) =>
        JSON.parse(localStorage.getItem(`window-fixture-${kind}`)).content.buffers.some(
          (buffer) => buffer.content === `Recovered ${kind} window edits`,
        ),
      kind,
    );
    await page.reload();
    await page.locator('[data-editor-surface] .monaco-editor').waitFor();
    await page.waitForFunction(async (text) => {
      const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
      return monaco.editor
        .getModels()
        .some((model) => model.uri.scheme === 'puddle' && model.getValue() === text);
    }, `Recovered ${kind} window edits`);
    await page.screenshot({ path: `/tmp/puddle-window-${kind}.png` });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Host/project/pane composition and dirty-buffer reload recovery pass.');
} finally {
  await browser.close();
}
