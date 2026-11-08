/* global window */
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

/** Actual host-only controls over the real capture/apply coordinators and preview catalogue. */
export async function checkCatalogueLayouts({
  state,
  source,
  pages,
  records,
  profileId,
  targetId,
  checkText,
}) {
  const target = pages.get(targetId);
  await target.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    window.catalogueEditor = monaco.editor
      .getEditors()
      .find((editor) => editor.getModel()?.getValue().startsWith('Unsaved text'));
  });
  await expect(target.getByRole('button', { name: 'Layouts', exact: true })).toHaveCount(0);
  await source.getByRole('button', { name: 'Layouts', exact: true }).click();
  await expect(source.getByRole('combobox', { name: 'Save layout for' })).toHaveText(
    'Profile-wide',
  );
  await source.getByPlaceholder('Name this layout…').fill('All windows');
  await source.getByRole('button', { name: 'Save', exact: true }).click();
  const row = source.getByRole('dialog').locator('li').first();
  await expect(row.getByText('Active', { exact: true })).toBeVisible();
  await checkText(target);
  assert.equal(
    await target.evaluate(async () =>
      (await import('/src/features/editor/monaco/monaco-setup.ts')).monaco.editor
        .getEditors()
        .includes(window.catalogueEditor),
    ),
    true,
    'Saving retains the mounted editor',
  );
  const saved = await source.evaluate(async () =>
    (await (await fetch('/api/layouts?profile=0000000001')).json()).find(
      (layout) => layout.name === 'All windows',
    ),
  );
  assert.equal(saved.window_arrangement.windows.length, 2);
  assert.equal(state.read('host', profileId).content.snapshot.layout_ref, saved.id);
  await source.screenshot({ path: '/tmp/puddle-live-layout-catalogue.png' });
  await row.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await row.getByRole('textbox').fill('All windows copy');
  await row.locator('form').getByRole('button', { name: 'Save', exact: true }).click();
  const duplicate = await source.evaluate(async () =>
    (await (await fetch('/api/layouts?profile=0000000001')).json()).find(
      (layout) => layout.name === 'All windows copy',
    ),
  );
  assert.deepEqual(duplicate.window_arrangement, saved.window_arrangement);
  await row.locator('p').click();
  const confirm = row.getByRole('button', { name: 'Load', exact: true });
  if (await confirm.isVisible()) await confirm.click();
  await expect(source.getByRole('combobox', { name: 'Save layout for' })).toHaveCount(0);
  assert.equal(records.size, 2, 'Loading the saved arrangement reuses existing windows');
  await checkText(target);
  await source.getByRole('button', { name: 'Layouts', exact: true }).click();
  await source.getByRole('combobox', { name: 'Save layout for' }).click();
  const projectName = await source.evaluate(
    async () => (await import('/src/dev/preview/data.ts')).project.name,
  );
  await source.getByRole('option', { name: projectName, exact: true }).click();
  await source.getByPlaceholder('Name this layout…').fill('Project windows');
  await source.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(source.locator('li').filter({ hasText: /^Project windows/ })).toBeVisible();
  const projectSaved = await source.evaluate(async () =>
    (await (await fetch('/api/layouts?profile=0000000001')).json()).find(
      (layout) => layout.name === 'Project windows',
    ),
  );
  assert.equal(projectSaved.scope, 'project');
  assert.equal(projectSaved.window_arrangement.windows.length, 2);
  await source.keyboard.press('Escape');
  console.log(
    'Live Layouts popover saves profile/project arrangements from the dashboard, preserves mounted dirty editors, duplicates and loads without duplicate windows.',
  );
}
