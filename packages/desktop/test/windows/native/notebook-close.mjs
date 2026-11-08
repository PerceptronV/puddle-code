/* global window, performance */
import assert from 'node:assert/strict';
import { openFilePane } from './close.mjs';

const notebook = (page) =>
  page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const text = monaco.editor
      .getModels()
      .find((m) => m.uri.scheme === 'puddle' && m.uri.path.endsWith('preview.ipynb'))
      ?.getValue();
    return text === undefined ? null : JSON.parse(text);
  });

/** Edit through the actual notebook cell, then review native close and reload its retained JSON. */
export async function checkNotebookClose(application, project, expect, state) {
  await project.locator('[data-path="examples"]').first().click();
  const pane = await openFilePane(application, project, expect, state, 'examples/preview.ipynb');
  const original = await notebook(pane);
  const mutations = [];
  await pane.exposeFunction('recordNotebookMutation', (value) => mutations.push(value));
  const observe = () =>
    pane.evaluate(async () => {
      const path = '/src/lib/transport/browser-transport.ts';
      const entry = performance
        .getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname === path);
      if (!entry) throw new Error('Live preview transport not observed');
      const { browserTransport } = await import(entry.name);
      const transport = browserTransport();
      if (transport?.scope !== 'ui-preview') throw new Error('Requires isolated preview');
      const original = transport.request.bind(transport);
      transport.request = async (method, path, body, signal) => {
        if (method !== 'GET' && (/\/notebooks\//.test(path) || /\/file(?:\?|$)/.test(path)))
          await window.recordNotebookMutation({ method, path });
        return original(method, path, body, signal);
      };
    });
  await observe();
  const toggle = pane.getByRole('button', {
    name: 'Show notebook',
    exact: true,
    includeHidden: true,
  });
  await toggle.focus();
  await pane.keyboard.press('Enter');
  const cell = pane.locator('[data-cell-id="hello"] .monaco-editor textarea');
  await expect(cell).toBeVisible();
  // Drive the real cell model and its onChange path. Native OS key delivery is
  // a separate acceptance gate; this fixture may run without application focus.
  await pane.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const cell = monaco.editor
      .getEditors()
      .find((editor) => editor.getDomNode()?.closest('[data-cell-id="hello"]'));
    if (!cell) throw new Error('Notebook cell editor is missing');
    cell.getModel().setValue('print("Retained notebook edit")');
  });
  await expect
    .poll(async () => (await notebook(pane))?.cells[1].source)
    .toEqual(['print("Retained notebook edit")']);
  const edited = await notebook(pane);
  assert.deepEqual(edited.cells[1].outputs, original.cells[1].outputs);
  assert.equal(edited.cells[1].execution_count, original.cells[1].execution_count);
  await pane.evaluate(() => window.puddleDesktop.closeWindow());
  const review = pane.getByRole('dialog', {
    name: 'Discard changes to preview.ipynb?',
    exact: true,
  });
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(review).toHaveCount(0);
  assert.deepEqual(await notebook(pane), edited);
  await Promise.all([
    pane.waitForEvent('domcontentloaded'),
    pane.evaluate(() => {
      void window.puddleDesktop.windows.reload();
    }),
  ]);
  await expect.poll(() => notebook(pane)).toEqual(edited);
  await expect(cell).toBeVisible();
  await observe();
  await pane.evaluate(() => window.puddleDesktop.closeWindow());
  await Promise.all([
    pane.waitForEvent('close'),
    review.getByRole('button', { name: 'Discard', exact: true }).click(),
  ]);
  assert.deepEqual(mutations, []);
  console.log(
    'Native notebook cell edits and saved outputs survive cancelled close/reload; discard performs no file save or kernel action.',
  );
}
