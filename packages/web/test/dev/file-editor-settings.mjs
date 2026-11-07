/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('[data-path="README.md"]').click();
  await page.locator('.monaco-editor[role=code]').first().waitFor();
  const edge = page.locator('[data-pane-single-edge]');
  await edge.waitFor();
  const pane = edge.locator('..');
  await pane.evaluate((element) => {
    element.style.width = '340px';
  });
  const box = await edge.boundingBox();
  await page.mouse.move(box.x + box.width - 8, box.y + 6);
  await page.getByRole('tooltip').filter({ hasText: 'README.md' }).waitFor();
  const tray = edge.locator('.pane-tab-controls');
  const trayBox = await tray.boundingBox();
  // Stop on each step: this must work without racing a tooltip/hover delay.
  for (let step = 1; step <= 12; step++) {
    await page.mouse.move(box.x + box.width - 8 + step / 3, box.y + 6 + step);
    await page.waitForTimeout(60);
    assert.equal(await tray.evaluate((el) => getComputedStyle(el).opacity), '1');
  }
  assert.ok(box.x + box.width - (trayBox.x + trayBox.width) <= 3);
  // Even while the path tooltip overlaps, controls win hit testing.
  const settingsButton = edge.getByRole('button', { name: 'Editor settings', exact: true });
  const buttonBox = await settingsButton.boundingBox();
  assert.ok(
    await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ===
        'Editor settings',
      {
        x: buttonBox.x + buttonBox.width / 2,
        y: buttonBox.y + buttonBox.height / 2,
      },
    ),
  );
  await settingsButton.click();
  const menu = page.getByRole('dialog', { name: 'Editor settings for this file' });
  await menu.waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({ path: '/tmp/puddle-file-editor-settings.png' });

  const modelState = () =>
    page.evaluate(async () => {
      const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
      const model = monaco.editor
        .getModels()
        .find((model) => model.uri.path.endsWith('/README.md'));
      const editor = monaco.editor.getEditors().find((editor) => editor.getModel() === model);
      return {
        language: model?.getLanguageId(),
        tabSize: model?.getOptions().tabSize,
        wrap: editor?.getOption(monaco.editor.EditorOption.wordWrap),
        content: model?.getValue(),
      };
    });
  const original = await modelState();
  await menu.getByRole('combobox', { name: 'Tab size', exact: true }).click();
  await page.getByRole('option', { name: '8', exact: true }).click();
  await menu.getByRole('combobox', { name: 'Word wrap', exact: true }).click();
  await page.getByRole('option', { name: 'On', exact: true }).click();
  await menu.getByRole('button', { name: 'Syntax highlighting', exact: true }).click();
  await page.getByRole('combobox', { name: 'Find a language' }).fill('python');
  await page.getByRole('option', { name: 'Python', exact: true }).click();
  await page.getByRole('combobox', { name: 'Find a language' }).waitFor({ state: 'detached' });
  assert.deepEqual(await modelState(), { ...original, language: 'python', tabSize: 8, wrap: 'on' });
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  // Remount the source view by opening another file, then return to it.
  await page.locator('[data-path="package.json"]').click();
  await page.locator('[data-pane-tab]').filter({ hasText: 'package.json' }).hover();
  await page.getByRole('button', { name: 'Editor settings', exact: true }).last().click();
  assert.match(
    await menu.getByRole('combobox', { name: 'Tab size', exact: true }).innerText(),
    /Default/,
  );
  assert.match(
    await menu.getByRole('combobox', { name: 'Word wrap', exact: true }).innerText(),
    /Default/,
  );
  assert.match(
    await menu.getByRole('button', { name: 'Syntax highlighting', exact: true }).innerText(),
    /Automatic \(JSON\)/,
  );
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  await page
    .locator('[data-pane-tab]')
    .filter({ hasText: 'README.md' })
    .click({ position: { x: 10, y: 10 } });
  await page.waitForFunction(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    return monaco.editor
      .getEditors()
      .some(
        (editor) =>
          editor.getDomNode()?.isConnected &&
          editor.getModel()?.uri.path.endsWith('/README.md') &&
          editor.getOption(monaco.editor.EditorOption.wordWrap) === 'on',
      );
  });
  assert.deepEqual(await modelState(), { ...original, language: 'python', tabSize: 8, wrap: 'on' });
  await page.locator('[data-pane-tab]').filter({ hasText: 'README.md' }).hover();
  await page.getByRole('button', { name: 'Editor settings', exact: true }).first().click();
  await menu.getByRole('combobox', { name: 'Tab size', exact: true }).click();
  await page.getByRole('option', { name: /^Default/ }).click();
  await menu.getByRole('combobox', { name: 'Word wrap', exact: true }).click();
  await page.getByRole('option', { name: /^Default/ }).click();
  await menu.getByRole('button', { name: 'Syntax highlighting', exact: true }).click();
  await page.getByRole('option', { name: /^Automatic/ }).click();
  assert.deepEqual(await modelState(), original);
  await page.getByRole('combobox', { name: 'Find a language' }).waitFor({ state: 'detached' });
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  const globalWrap = await page.evaluate(async () => {
    const { clientSettings } = await import('/src/lib/settings/client-settings.ts');
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const editor = monaco.editor
      .getEditors()
      .find(
        (editor) =>
          editor.getDomNode()?.closest('[data-editor-surface]') &&
          editor.getModel()?.uri.path.endsWith('/README.md'),
      );
    await editor.getAction('puddle.toggleWordWrap').run();
    return clientSettings().editorWordWrap;
  });
  assert.equal((await modelState()).wrap, original.wrap === 'on' ? 'off' : 'on');
  assert.equal(globalWrap, original.wrap === 'on');
  const languages = await page.evaluate(async () => {
    const { editorLanguages } = await import('/src/features/editor/monaco/languages.ts');
    return editorLanguages().map(({ id, label }) => `${label} (${id})`);
  });
  console.log('Languages:', languages.join(', '));
  assert.deepEqual(errors, []);
  console.log(
    'Corner hover, tooltip stacking, per-file options, isolation, remount and reset pass.',
  );
} finally {
  await browser.close();
}
