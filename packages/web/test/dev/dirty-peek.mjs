import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Uses the running daemon-free preview; real pointer clicks catch overlapping Monaco layers.
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://localhost:5174/');
  await page.locator('[data-path="package.json"]').dblclick();
  await page.waitForSelector('.puddle-hidden-diff-controller', { state: 'attached' });
  await page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const model = monaco.editor
      .getModels()
      .find((candidate) => candidate.uri.path.endsWith('package.json'));
    if (!model) throw new Error('Sample editor model missing');
    model.setValue(model.getValue() + '\n\n// local change');
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const marker = page.locator('.puddle-dirty-added').first();
    await marker.waitFor();
    const box = await marker.boundingBox();
    assert.ok(box);
    await page.mouse.click(box.x + 1, box.y + 3);
    const close = page.locator('.puddle-dirty-peek-close');
    await close.waitFor();
    await close.click();
    await page.locator('.puddle-dirty-peek').waitFor({ state: 'detached' });
  }
  assert.deepEqual(errors, []);
  console.log('Inline diff preview opens, closes by pointer and reopens without errors.');
} finally {
  await browser.close();
}
