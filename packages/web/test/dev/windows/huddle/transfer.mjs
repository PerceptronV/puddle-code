import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

async function openGraph(page, profile, session) {
  await page.evaluate(
    async ({ profile, session }) => {
      const { desktopWorkingSet } = await import('/src/features/windows/use-desktop-state.ts');
      const { queryClient } = await import('/src/lib/queries/client.ts');
      await queryClient.invalidateQueries({ queryKey: ['sessions'] });
      await queryClient.invalidateQueries({ queryKey: ['project', session.project_id] });
      const owner = desktopWorkingSet(profile);
      await owner.flush();
      const snapshot = owner.get();
      owner.update({
        ...snapshot,
        layout_mode: 'profile',
        project_layouts: {},
        active_session: session.id,
        layout_tree: {
          kind: 'leaf',
          id: 'huddle-transfer',
          tabs: [{ type: 'huddle', session: session.id }],
          activeKey: `huddle:${session.id}`,
        },
      });
      await owner.flush();
    },
    { profile, session },
  );
  await page.getByRole('region', { name: 'Huddle editor' }).waitFor();
  await page.getByRole('button', { name: 'Run event', exact: true }).waitFor();
}
async function editName(page, name) {
  await page.evaluate(async (name) => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const model = monaco.editor
      .getModels()
      .find((model) => model.uri.path.endsWith('/huddle.json'));
    if (!model) throw new Error('Missing graph model');
    model.setValue(JSON.stringify({ ...JSON.parse(model.getValue()), name }, null, 2));
  }, name);
}
export async function checkHuddleTransfer({
  source,
  target,
  profile,
  backend,
  records,
  pages,
  state,
}) {
  const session = backend.session;
  await openGraph(source, profile, session);
  await editName(source, 'Transferred huddle draft');
  const editor = source.getByRole('region', { name: 'Huddle editor' });
  await editor.getByText('Unsaved changes', { exact: true }).waitFor();
  await editor.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await editor.getByRole('button', { name: 'Result value', exact: true }).click();
  const before = new Set(records.keys());
  await source
    .locator(`[data-pane-tab="huddle:${session.id}"]`)
    .dispatchEvent('contextmenu', { button: 2 });
  await source.getByRole('menuitem', { name: 'Open session in window', exact: true }).click();
  await expect.poll(() => [...records.keys()].filter((id) => !before.has(id)).length).toBe(1);
  const record = [...records.values()].find((value) => !before.has(value.window.id));
  await expect.poll(() => pages.has(record.window.id)).toBe(true);
  const destination = pages.get(record.window.id);
  const moved = destination.getByRole('region', { name: 'Huddle editor' });
  await moved.getByText('Transferred huddle draft', { exact: true }).waitFor();
  await moved.getByText('Unsaved changes', { exact: true }).waitFor();
  await expect(moved.getByRole('button', { name: 'Reset zoom', exact: true })).toHaveText('125%');
  await expect(moved.getByRole('button', { name: 'Result value', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(source.getByRole('region', { name: 'Huddle editor' })).toHaveCount(0);
  const held = state.read(record.window.id, profile).content;
  assert.ok(
    held.buffers.some(
      (buffer) =>
        buffer.path === backend.root + 'huddle.json' &&
        buffer.content.includes('Transferred huddle draft'),
    ),
  );
  assert.ok(held.buffers.some((buffer) => buffer.baseRevision?.digest));
  assert.equal(backend.name(), 'Window huddle', 'moving a view does not save source');

  // Reload the committed destination before any save: restoration uses its durable capture.
  await destination.reload();
  await moved.getByText('Transferred huddle draft', { exact: true }).waitFor();
  await moved.getByText('Unsaved changes', { exact: true }).waitFor();
  await expect(moved.getByRole('button', { name: 'Reset zoom', exact: true })).toHaveText('125%');
  await expect(moved.getByRole('button', { name: 'Result value', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // A second renderer edits the same source, while the moved renderer keeps its draft.
  await openGraph(target, profile, session);
  await editName(target, 'Saved in another window');
  await target
    .getByRole('region', { name: 'Huddle editor' })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect.poll(() => backend.name()).toBe('Saved in another window');
  await moved.getByRole('button', { name: 'Save', exact: true }).click();
  await moved.getByRole('button', { name: 'Compare', exact: true }).waitFor();
  assert.equal(
    backend.name(),
    'Saved in another window',
    'a stale transferred draft cannot replace a peer save',
  );
  await moved.getByRole('button', { name: 'Compare', exact: true }).click();
  await moved.getByRole('button', { name: 'Keep mine', exact: true }).waitFor();
  backend.externalName('External agent edit');
  await moved.getByRole('button', { name: 'Keep mine', exact: true }).click();
  await moved.getByRole('button', { name: 'Compare', exact: true }).waitFor();
  assert.equal(backend.name(), 'External agent edit', 'an edit after review invalidates Keep mine');
  await moved.getByRole('button', { name: 'Compare', exact: true }).click();
  await moved.getByRole('button', { name: 'Keep mine', exact: true }).click();
  await expect.poll(() => backend.name()).toBe('Transferred huddle draft');
  assert.equal(
    backend.requests.some(({ path }) => /\/(start|run|apply|rearm|stop|resume)$/.test(path)),
    false,
  );
  console.log(
    'Huddle handoff and destination reload preserve dirty source, captured baseline and view; peer/external edits require fresh conflict review.',
  );
}
