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
  commands,
  openPage,
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
  let destination = pages.get(record.window.id);
  let moved = destination.getByRole('region', { name: 'Huddle editor' });
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

  // Persist a newer draft and view through ordinary background capture, then lose
  // the renderer without pagehide, a checkpoint command or a graceful close.
  await editName(destination, 'Recovered huddle draft');
  await moved.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await moved.getByRole('button', { name: 'Run event', exact: true }).click();
  await expect
    .poll(() => {
      const content = state.read(record.window.id, profile).content;
      return (
        content.buffers.some((buffer) => buffer.content.includes('Recovered huddle draft')) &&
        Object.entries(content.views).some(
          ([key, view]) =>
            key.startsWith('huddle:') && view?.selectedNode === 'run' && view?.camera?.zoom === 1,
        )
      );
    })
    .toBe(true);
  const captured = state.read(record.window.id, profile);
  const generation = commands.generation(record.window.id);
  const protocol = await destination.context().newCDPSession(destination);
  const crashed = destination.waitForEvent('crash', { timeout: 10_000 });
  // Chromium can lose this command's reply along with the renderer. The crash
  // event is the evidence; never wait for acknowledgement from the dead process.
  void protocol.send('Page.crash').catch(() => {});
  await crashed;
  console.log('Huddle renderer crash observed; restoring the background capture.');
  assert.equal(commands.available(record.window.id), false);
  assert.deepEqual(state.read(record.window.id, profile), captured);
  // Playwright permanently marks crashed pages unavailable. Create a fresh
  // renderer under the same native window identity; close() also disposes CDP.
  await destination.close();
  await openPage(record);
  destination = pages.get(record.window.id);
  moved = destination.getByRole('region', { name: 'Huddle editor' });
  await moved.getByText('Recovered huddle draft', { exact: true }).waitFor();
  await moved.getByText('Unsaved changes', { exact: true }).waitFor();
  await expect(moved.getByRole('button', { name: 'Reset zoom', exact: true })).toHaveText('100%');
  await expect(moved.getByRole('button', { name: 'Run event', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect.poll(() => commands.generation(record.window.id)).toBeGreaterThan(generation);
  assert.equal(backend.name(), 'Window huddle', 'crash recovery does not save source');

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
  await expect.poll(() => backend.name()).toBe('Recovered huddle draft');
  assert.equal(
    backend.requests.some(({ path }) => /\/(start|run|apply|rearm|stop|resume)$/.test(path)),
    false,
  );
  console.log(
    'Huddle handoff, reload and renderer crash preserve dirty source, captured baseline and view; peer/external edits require fresh conflict review.',
  );
}
