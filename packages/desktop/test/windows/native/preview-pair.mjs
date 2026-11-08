/* global window, DataTransfer */
import assert from 'node:assert/strict';

const draft = '# Retained preview pair\n\nUnsaved source and preview text.\n';
const sourceText = (page) =>
  page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    return monaco.editor
      .getModels()
      .find((model) => model.uri.scheme === 'puddle' && model.uri.path.endsWith('README.md'))
      ?.getValue();
  });

async function returnToProject(page) {
  await page.locator('[data-pane-drag-handle]').dispatchEvent('contextmenu', { button: 2 });
  const failure = page.locator('[data-sonner-toast][data-type="error"]');
  await Promise.all([
    Promise.race([
      page.waitForEvent('close'),
      failure.waitFor({ state: 'visible' }).then(async () => {
        throw new Error(`Native docking failed: ${await failure.innerText()}`);
      }),
    ]),
    page.getByRole('menuitem', { name: 'Return pane to puddle', exact: true }).click(),
  ]);
}

/** Real native menu handoffs, with an in-document drop used only to prepare the pair. */
export async function checkPreviewPair(application, project, expect, state) {
  const file = project.locator('[data-path="README.md"]').first();
  await file.dblclick();
  await project.locator('[data-editor-surface] .monaco-editor').first().waitFor();
  await project.evaluate(async (text) => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    monaco.editor
      .getModels()
      .find((model) => model.uri.scheme === 'puddle' && model.uri.path.endsWith('README.md'))
      .setValue(text);
  }, draft);
  const data = await project.evaluateHandle(() => new DataTransfer());
  await file.dispatchEvent('dragstart', { dataTransfer: data });
  const surface = project.locator('[data-editor-surface]').first();
  const bounds = await surface.boundingBox();
  const event = {
    dataTransfer: data,
    clientX: bounds.x + bounds.width - 3,
    clientY: bounds.y + bounds.height / 2,
  };
  await surface.dispatchEvent('dragover', event);
  await surface.dispatchEvent('drop', event);
  const panes = project.locator('[data-workspace-pane]');
  await expect(panes).toHaveCount(2);
  const preview = panes.nth(1);
  for (const name of [
    'Source — switch to preview',
    'Preview — switch to linked preview',
    'Linked preview — switch to locked preview',
  ]) {
    await preview.getByRole('button', { name, exact: true, includeHidden: true }).focus();
    await project.keyboard.press('Enter');
  }
  await expect(
    preview.getByRole('heading', { name: 'Retained preview pair', exact: true }),
  ).toBeVisible();
  const sourceId = await panes.first().getAttribute('data-workspace-pane');
  const previewId = await preview.getAttribute('data-workspace-pane');
  await panes
    .first()
    .locator('[data-pane-drag-handle]')
    .dispatchEvent('contextmenu', { button: 2 });
  const [detached] = await Promise.all([
    application.waitForEvent('window'),
    project.getByRole('menuitem', { name: 'Open pane in window', exact: true }).click(),
  ]);
  await expect.poll(() => sourceText(detached)).toBe(draft);
  await expect.poll(async () => Object.keys((await state()).pending).length).toBe(0);
  await expect(project.locator(`[data-workspace-pane="${sourceId}"]`)).toHaveCount(0);
  await expect(
    project
      .locator(`[data-workspace-pane="${previewId}"]`)
      .getByRole('heading', { name: 'Retained preview pair', exact: true }),
  ).toBeVisible();
  await returnToProject(detached);
  await expect.poll(async () => Object.keys((await state()).pending).length).toBe(0);
  await expect(panes).toHaveCount(2);
  await expect.poll(() => sourceText(project)).toBe(draft);
  await expect(
    project.getByRole('heading', { name: 'Retained preview pair', exact: true }),
  ).toBeVisible();
  const previewPane = panes.filter({
    has: project.getByRole('heading', { name: 'Retained preview pair', exact: true }),
  });
  await previewPane.locator('[data-pane-drag-handle]').dispatchEvent('contextmenu', { button: 2 });
  const [detachedPreview] = await Promise.all([
    application.waitForEvent('window'),
    project.getByRole('menuitem', { name: 'Open pane in window', exact: true }).click(),
  ]);
  await expect(
    detachedPreview.getByRole('heading', { name: 'Retained preview pair', exact: true }),
  ).toBeVisible();
  await expect.poll(async () => Object.keys((await state()).pending).length).toBe(0);
  await expect(panes).toHaveCount(1);
  await expect.poll(() => sourceText(project)).toBe(draft);
  await returnToProject(detachedPreview);
  await expect.poll(async () => Object.keys((await state()).pending).length).toBe(0);
  await expect(panes).toHaveCount(2);
  await Promise.all([
    project.waitForEvent('domcontentloaded'),
    project.evaluate(() => {
      void window.puddleDesktop.windows.reload();
    }),
  ]);
  await expect(panes).toHaveCount(2);
  await expect.poll(() => sourceText(project)).toBe(draft);
  await expect(
    project.getByRole('button', {
      name: 'Locked preview — switch to source',
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(1);
  await expect(
    project.getByRole('heading', { name: 'Retained preview pair', exact: true }),
  ).toBeVisible();
  const close = project.getByRole('button', {
    name: 'Close README.md',
    exact: true,
    includeHidden: true,
  });
  await expect(close).toHaveCount(2);
  await close.first().focus();
  await project.keyboard.press('Enter');
  await expect(close).toHaveCount(1);
  await expect(project.getByRole('dialog')).toHaveCount(0);
  assert.equal(await sourceText(project), draft);
  await close.focus();
  await project.keyboard.press('Enter');
  await project.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(close).toHaveCount(0);
  console.log(
    'Native source and locked-preview panes retain dirty text through independent detachment, project docking and reload; final-view discard is shared.',
  );
}
