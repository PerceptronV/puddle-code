/* global window, Response */
import assert from 'node:assert/strict';

export async function openFilePane(application, project, expect, state, path = 'package.json') {
  await project.locator(`[data-path="${path}"]`).first().dblclick();
  await project
    .locator('[data-pane-tab^="editor:"]')
    .click({ button: 'right', position: { x: 10, y: 2 } });
  const [pane] = await Promise.all([
    application.waitForEvent('window'),
    project.getByRole('menuitem', { name: 'Open file in window', exact: true }).click(),
  ]);
  await expect.poll(async () => Object.keys((await state()).pending).length).toBe(0);
  await pane.locator('[data-editor-surface] .monaco-editor').first().waitFor();
  return pane;
}

export async function checkCleanPaneClose(application, project, expect, state) {
  const pane = await openFilePane(application, project, expect, state);
  const { identity } = await pane.evaluate(() => window.puddleDesktop.windows.context());
  await Promise.all([
    pane.waitForEvent('close'),
    pane.evaluate(() => window.puddleDesktop.closeWindow()),
  ]);
  await expect.poll(async () => (await state()).entries[identity.id].open).toBe(false);
  console.log(
    'Clean file pane closes directly while sibling windows retain their host connection.',
  );
}

/** Synthetic draft storage; real workspace, native close events and user dialogues. */
export async function prepareUntitledClose(page, expect) {
  await page.evaluate(async () => {
    const { browserTransport } = await import('/src/lib/transport/browser-transport.ts');
    const transport = browserTransport();
    if (transport?.scope !== 'ui-preview') throw new Error('Requires isolated preview');
    const original = transport.request.bind(transport);
    window.nativeDraftClose = { events: [], failDelete: true };
    transport.request = async (method, path, body, signal) => {
      if (!path.includes('/untitled')) return original(method, path, body, signal);
      const state = window.nativeDraftClose;
      if (method === 'POST') return Response.json({ name: 'untitled-1.md' });
      if (method === 'GET')
        return Response.json({ name: 'untitled-1.md', content: '', mtime_ms: 1 });
      if (method === 'PUT') {
        state.events.push('put-start');
        await new Promise((resolve) => {
          state.releaseWrite = resolve;
        });
        state.events.push('put-done');
        return Response.json({ mtime_ms: 2 });
      }
      if (method === 'DELETE') {
        state.events.push(state.failDelete ? 'delete-failed' : 'delete-ok');
        return state.failDelete
          ? Response.json(
              { error: { code: 'forbidden', message: 'Fixture draft deletion denied' } },
              { status: 403 },
            )
          : new Response(null, { status: 204 });
      }
      throw new Error('Unexpected draft operation');
    };
  });
  await page.keyboard.press('Meta+n');
  await expect(
    page.getByRole('button', { name: 'Close untitled-1.md', exact: true }),
  ).toBeAttached();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
        return monaco.editor.getModels().some((model) => model.uri.scheme === 'puddle-untitled');
      }),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    monaco.editor
      .getModels()
      .find((model) => model.uri.scheme === 'puddle-untitled')
      .setValue('Retain this untitled draft');
  });
  await expect
    .poll(() => page.evaluate(() => window.nativeDraftClose.events))
    .toEqual(['put-start']);
}

export async function finishUntitledClose(page, expect) {
  const review = page.getByRole('dialog', { name: 'Discard this draft?', exact: true });
  await expect(review).toBeVisible();
  await expect(review).toContainText('untitled-1.md');
  await review.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(review).toHaveCount(0);
  await page.evaluate(() => window.puddleDesktop.closeWindow());
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(review.getByRole('button', { name: 'Discard', exact: true })).toBeDisabled();
  assert.deepEqual(await page.evaluate(() => window.nativeDraftClose.events), ['put-start']);
  await page.evaluate(() => window.nativeDraftClose.releaseWrite());
  await expect(page.getByText('Fixture draft deletion denied', { exact: true })).toBeVisible();
  await expect(review).toBeVisible();
  await expect(review.getByRole('button', { name: 'Discard', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    window.nativeDraftClose.failDelete = false;
  });
  const closed = page.waitForEvent('close');
  await review.getByRole('button', { name: 'Discard', exact: true }).click();
  await closed;
}
