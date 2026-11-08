/* global window */
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

/** Real coordinator + renderer planner, using existing preview windows without a daemon. */
export async function checkArrangementApply({
  state,
  source,
  records,
  pages,
  profileId,
  targetId,
  checkText,
}) {
  const descriptors = ['host', targetId].map((id) => {
    const identity = records.get(id).window;
    const snapshot = state.read(id, profileId).content.snapshot;
    return {
      key: id,
      kind: identity.kind,
      project_id: identity.kind === 'host' ? null : identity.projectId,
      layout_mode: snapshot.layout_mode ?? 'profile',
      layout_tree: snapshot.layout_tree,
      active_session: snapshot.active_session,
      project_layouts: Object.fromEntries(
        Object.entries(snapshot.project_layouts).map(([id, slice]) => [
          id,
          {
            layout_tree: slice.layout_tree,
            active_session: slice.active_session,
          },
        ]),
      ),
    };
  });
  const extra = { ...descriptors[1], key: 'extra-pane', kind: 'pane' };
  const apply = async (id, windows) => {
    const request = { id, profileId, scope: 'profile', arrangement: { version: 1, windows } };
    const result = await source.evaluate(
      (request) => window.windowRequest('layout-apply', request),
      request,
    );
    assert.deepEqual(result, { status: 'committed' });
  };
  await apply('layout-add-pane', [...descriptors, extra]);
  await expect.poll(() => records.size).toBe(3);
  const created = [...records.values()].find((record) => record.window.kind === 'pane');
  assert.ok(created, 'The coordinator opened the missing pane slot');
  await checkText(pages.get(created.window.id));
  await checkText(pages.get(targetId));
  await apply('layout-repeat', [...descriptors, extra]);
  assert.equal(records.size, 3);
  assert.ok(records.has(created.window.id), 'Repeated loading reuses the matched native window');
  await checkText(pages.get(created.window.id));
  await apply('layout-retire-pane', descriptors);
  await expect.poll(() => records.size).toBe(2);
  assert.ok(!records.has(created.window.id));
  await checkText(pages.get(targetId));
  assert.equal(
    state.read(targetId, profileId).content.buffers[0].content,
    'Unsaved text moved through the real coordinator',
  );
  await pages.get(targetId).screenshot({ path: '/tmp/puddle-live-layout-apply.png' });
  console.log(
    'Live arrangement apply creates and reuses a pane slot, preserves dirty views and retires it after acceptance.',
  );
}

/** Run after docking, when the host owns its visible project again. */
export async function checkArrangementMode({ state, source, profileId, checkText }) {
  const snapshot = state.read('host', profileId).content.snapshot;
  const projectId = new URL(source.url()).pathname.split('/')[2];
  assert.equal(snapshot.layout_mode, 'project');
  const original = {
    key: 'host',
    kind: 'host',
    project_id: projectId,
    layout_mode: 'project',
    layout_tree: snapshot.layout_tree,
    active_session: snapshot.active_session,
    project_layouts: Object.fromEntries(
      Object.entries(snapshot.project_layouts).map(([id, slice]) => [
        id,
        {
          layout_tree: slice.layout_tree,
          active_session: slice.active_session,
        },
      ]),
    ),
  };
  const profile = {
    ...original,
    layout_mode: 'profile',
    project_layouts: {},
    layout_tree: snapshot.project_layouts[projectId].layout_tree,
    active_session: snapshot.project_layouts[projectId].active_session,
  };
  const apply = async (id, descriptor) => {
    const result = await source.evaluate(
      (request) => window.windowRequest('layout-apply', request),
      {
        id,
        profileId,
        scope: 'profile',
        arrangement: { version: 1, windows: [descriptor] },
      },
    );
    assert.deepEqual(result, { status: 'committed' });
    await checkText(source);
  };
  await apply('layout-profile-mode', profile);
  assert.equal(state.read('host', profileId).content.snapshot.layout_mode, 'profile');
  assert.equal(
    await source.evaluate(
      async () =>
        (await import('/src/lib/settings/client-settings.ts')).clientSettings().projectBasedLayout,
    ),
    true,
  );
  await source.reload();
  await checkText(source);
  assert.equal(state.read('host', profileId).content.snapshot.layout_mode, 'profile');
  await source.evaluate(() => {
    window.location.hash = 'settings/appearance';
  });
  const toggle = source.locator('#project-based-layout');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect
    .poll(() => state.read('host', profileId).content.snapshot.layout_mode)
    .toBe('project');
  await source.evaluate(() => {
    window.location.hash = '';
  });
  await apply('layout-original-mode', original);
  assert.equal(state.read('host', profileId).content.snapshot.layout_mode, 'project');
  console.log(
    'Live native layout mode survives remount and reload without rewriting the client preference.',
  );
}
