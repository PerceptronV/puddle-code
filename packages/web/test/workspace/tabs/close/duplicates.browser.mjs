/* global DataTransfer, URLSearchParams */
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const file = page.locator('[data-path="package.json"]');
  await file.dblclick();
  await page.waitForSelector('.puddle-hidden-diff-controller', { state: 'attached' });
  const original = await page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const model = monaco.editor.getModels().find((m) => m.uri.path.endsWith('package.json'));
    const original = model.getValue();
    model.setValue(original + '\n// shared dirty draft');
    return original;
  });
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await file.dispatchEvent('dragstart', { dataTransfer: transfer });
  const surface = page.locator('[data-editor-surface]').first();
  const bounds = await surface.boundingBox();
  const event = {
    dataTransfer: transfer,
    clientX: bounds.x + bounds.width - 3,
    clientY: bounds.y + bounds.height / 2,
  };
  await surface.dispatchEvent('dragover', event);
  await surface.dispatchEvent('drop', event);
  const close = page.getByRole('button', {
    name: 'Close package.json',
    exact: true,
    includeHidden: true,
  });
  await expect(close).toHaveCount(2);
  await close.first().focus();
  await page.keyboard.press('Enter');
  await expect(close).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const text = () =>
    page.evaluate(async () => {
      const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
      return monaco.editor
        .getModels()
        .find((m) => m.uri.path.endsWith('package.json'))
        ?.getValue();
    });
  assert.equal(await text(), original + '\n// shared dirty draft');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
        const { loadDraft } = await import('/src/lib/persistence/drafts.ts');
        const uri = monaco.editor.getModels().find((m) => m.uri.path.endsWith('package.json')).uri;
        return (
          await loadDraft(
            decodeURIComponent(uri.authority),
            'package.json',
            new URLSearchParams(uri.query).get('root') ?? undefined,
          )
        )?.content;
      }),
    )
    .toBe(original + '\n// shared dirty draft');
  await page.reload();
  await expect.poll(text).toBe(original + '\n// shared dirty draft');
  await close.focus();
  await page.keyboard.press('Enter');
  const review = page.getByRole('dialog', { name: 'Discard changes to package.json?' });
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(review).toHaveCount(0);
  assert.equal(await text(), original + '\n// shared dirty draft');
  await close.focus();
  await page.keyboard.press('Enter');
  await review.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(close).toHaveCount(0);
  await file.dblclick();
  await expect.poll(text).toBe(original);
  assert.deepEqual(errors, []);
  console.log(
    'Closing a duplicate preserves the shared model and draft; only the last view reviews discard.',
  );
} finally {
  await browser.close();
}
