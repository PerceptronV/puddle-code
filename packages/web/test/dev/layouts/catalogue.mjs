/* global window */
// Ordinary browser layout controls against the daemon-free UI preview.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.PREVIEW_URL ?? 'http://127.0.0.1:5186/');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('[data-path="package.json"]').dblclick();
  await page.getByRole('button', { name: 'Layouts', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Save layout for' })).toHaveCount(0);
  await page.getByPlaceholder('Name this layout…').fill('Browser layout');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
        window.savedLayoutEditor = monaco.editor
          .getEditors()
          .find((editor) => editor.getModel()?.uri.path.endsWith('/package.json'));
        if (!window.savedLayoutEditor) return false;
        window.savedLayoutEditor.getModel().setValue('Unsaved browser text');
        return true;
      }),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const row = page.getByRole('dialog').locator('li').first();
  await expect(row.getByText('Active', { exact: true })).toBeVisible();
  const editorState = await page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    return {
      sameEditor: monaco.editor.getEditors().includes(window.savedLayoutEditor),
      previous: window.savedLayoutEditor.getModel()?.getValue(),
      editors: monaco.editor.getEditors().map((editor) => ({
        uri: editor.getModel()?.uri.toString(),
        text: editor.getModel()?.getValue(),
      })),
    };
  });
  assert.ok(
    editorState.sameEditor && editorState.previous === 'Unsaved browser text',
    JSON.stringify(editorState),
  );
  const saved = await page.evaluate(
    async () => (await (await fetch('/api/layouts?profile=0000000001')).json())[0],
  );
  assert.equal(saved.name, 'Browser layout');
  assert.equal(saved.window_arrangement, undefined);
  await row.locator('p').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log('Browser layout save preserves dirty editors and the single-tree load path.');
} finally {
  await browser.close();
}
