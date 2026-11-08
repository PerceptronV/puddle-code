/* global window */
import assert from 'node:assert/strict';
import { openFilePane } from './close.mjs';

const modelText = (page, value) =>
  page.evaluate(async (value) => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const model = monaco.editor.getModels().find((m) => m.uri.path.endsWith('package.json'));
    if (value !== undefined) model.setValue(value);
    return model?.getValue();
  }, value);

/** Native windows keep independent drafts even when their file identity is the same. */
export async function checkIndependentDrafts(application, project, expect, state) {
  const pane = await openFilePane(application, project, expect, state);
  await modelText(pane, 'Independent pane edits');
  await project.locator('[data-path="package.json"]').first().dblclick();
  await project.locator('[data-editor-surface] .monaco-editor').first().waitFor();
  await modelText(project, 'Retain independent project edits');
  const { identity } = await project.evaluate(() => window.puddleDesktop.windows.context());
  const retained = async () =>
    (await state()).entries[identity.id].workspaces[identity.profileId].content.buffers.find(
      (buffer) => buffer.path === 'package.json',
    )?.content;
  await expect.poll(retained).toBe('Retain independent project edits');
  assert.equal(await modelText(pane), 'Independent pane edits');

  await pane.evaluate(() => window.puddleDesktop.closeWindow());
  const review = pane.getByRole('dialog', {
    name: 'Discard changes to package.json?',
    exact: true,
  });
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect.poll(() => modelText(pane)).toBe('Independent pane edits');
  await expect.poll(() => modelText(project)).toBe('Retain independent project edits');
  await pane.evaluate(() => window.puddleDesktop.closeWindow());
  await Promise.all([
    pane.waitForEvent('close'),
    review.getByRole('button', { name: 'Discard', exact: true }).click(),
  ]);
  assert.equal(await modelText(project), 'Retain independent project edits');
  assert.equal(await retained(), 'Retain independent project edits');

  // Real checkpoint/reload must restore the surviving window's own draft, even
  // after the other renderer removed the shared browser draft cache entry.
  await Promise.all([
    project.waitForEvent('domcontentloaded'),
    project.evaluate(() => {
      void window.puddleDesktop.windows.reload();
    }),
  ]);
  await expect.poll(() => modelText(project)).toBe('Retain independent project edits');
  await modelText(project, 'Project edits after peer discard');
  await expect.poll(retained).toBe('Project edits after peer discard');
  const close = project.getByRole('button', {
    name: 'Close package.json',
    exact: true,
    includeHidden: true,
  });
  await close.focus();
  await project.keyboard.press('Enter');
  const projectReview = project.getByRole('dialog', {
    name: 'Discard changes to package.json?',
    exact: true,
  });
  await projectReview.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(close).toHaveCount(0);
  console.log(
    'Native duplicate views retain independent edits through peer discard and checkpoint/reload.',
  );
}
