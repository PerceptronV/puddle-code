import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

// Actual workspace, Monaco and dirty dialogue against the daemon-free preview.
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let releaseClose;
  const closeReady = new Promise((resolve) => {
    releaseClose = resolve;
  });
  await page.route('**/tabs/EditorTabClose.tsx*', async (route) => {
    await closeReady;
    await route.continue();
  });
  await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const file = page.locator('[data-path="package.json"]');
  await file.dblclick();
  const close = page.getByRole('button', { name: /Close .*package\.json$/, includeHidden: true });
  await expect(close).toBeDisabled();
  await page.keyboard.press('Control+Alt+w');
  await expect(close).toBeAttached();
  releaseClose();
  await expect(close).toBeEnabled();
  await page.waitForSelector('.puddle-hidden-diff-controller', { state: 'attached' });
  const original = await page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const model = monaco.editor.getModels().find((m) => m.uri.path.endsWith('package.json'));
    if (!model) throw new Error('Editor missing');
    const text = model.getValue();
    model.setValue(text + '\n// retain until approved');
    return text;
  });
  const text = () =>
    page.evaluate(async () => {
      const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
      return monaco.editor
        .getModels()
        .find((m) => m.uri.path.endsWith('package.json'))
        ?.getValue();
    });
  const review = page.getByRole('dialog', { name: /Discard changes to .*package\.json\?/ });
  await page.locator('.monaco-editor textarea').first().focus();
  await page.keyboard.press('Control+Alt+w');
  await expect(review).toBeVisible();
  await page.keyboard.press('Control+Alt+w');
  await expect(review).toHaveCount(1);
  await review.getByRole('button', { name: 'Keep editing' }).click();
  await expect(review).toHaveCount(0);
  assert.equal(await text(), original + '\n// retain until approved');
  await expect(close).toBeAttached();

  // The button shares the same policy; Escape also retains the text and tab.
  await close.focus();
  await page.keyboard.press('Enter');
  await expect(review).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(review).toHaveCount(0);
  assert.equal(await text(), original + '\n// retain until approved');
  // Discard while the latest edit is still inside the draft writer's debounce.
  await page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const model = monaco.editor.getModels().find((m) => m.uri.path.endsWith('package.json'));
    model.setValue(model.getValue() + '\n// pending draft write');
  });
  await page.locator('.monaco-editor textarea').first().focus();
  await page.keyboard.press('Control+Alt+w');
  await review.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(close).toHaveCount(0);
  await file.dblclick();
  await expect(close).toBeEnabled();
  await expect.poll(text).toBe(original);
  await page.locator('.monaco-editor textarea').first().focus();
  await page.keyboard.press('Control+Alt+w');
  await expect(close).toHaveCount(0);
  await expect(review).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log(
    'Keyboard and button close share dirty review; cancellation retains text, approved discard removes it, and clean tabs close directly.',
  );
} finally {
  await browser.close();
}
