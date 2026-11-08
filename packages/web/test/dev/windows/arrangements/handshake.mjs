// Existing preview pages exercise the real Workspace/dashboard readiness hooks.
// Stage/verify/finish are exercised directly here; the apply and catalogue
// fixtures cover the complete coordinator and named-layout controls.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function checkArrangementHandshake({
  state,
  commands,
  records,
  pages,
  openPage,
  profileId,
  targetId,
  checkText,
}) {
  const ids = ['host', targetId];
  const originals = ids.map((id) => ({
    ...records.get(id),
    route: new URL(pages.get(id).url()).pathname,
  }));
  const identities = () =>
    state
      .openWindows()
      .map((record) => record.window.id)
      .sort();
  const before = identities();
  const seal = async (arrangementId) =>
    Promise.all(
      ids.map((id) =>
        commands.arrangement(id, {
          kind: 'seal-layout',
          arrangementId,
          profileId,
        }),
      ),
    );
  const stage = async (id, arrangementId, route) =>
    commands.arrangement(id, {
      kind: 'stage-layout',
      arrangementId,
      profileId,
      route,
      version: state.readPresentation(id, profileId),
    });
  const verify = async (id, arrangementId) =>
    commands.arrangement(id, {
      kind: 'verify-layout',
      arrangementId,
      profileId,
    });
  const finish = async (id, arrangementId, outcome) =>
    commands.arrangement(id, {
      kind: 'finish-layout',
      arrangementId,
      profileId,
      outcome,
    });

  // Cancel a replacement after both the dashboard and a new native-style pane
  // have mounted. The source workspace was released but must remain recoverable.
  const cancelled = 'cancelled-layout';
  const captured = await seal(cancelled);
  const newId = 'layout-replacement';
  const replacement = {
    target: 'local',
    route: originals[1].route,
    window: { ...originals[1].window, id: newId, kind: 'pane' },
  };
  state.prepareArrangement({
    id: cancelled,
    ownerId: 'host',
    profileId,
    scope: 'profile',
    changes: [
      { record: originals[0], ...captured[0], open: true },
      { record: originals[1], ...captured[1], open: false },
      { record: replacement, revision: 0, content: captured[1].content, open: true },
    ],
  });
  await openPage(replacement);
  await expect.poll(() => commands.available(newId)).toBe(true);
  await Promise.all([
    stage('host', cancelled, originals[0].route),
    stage(newId, cancelled, replacement.route),
  ]);
  await checkText(pages.get(newId));
  assert.equal(
    await pages
      .get(newId)
      .locator('#root')
      .evaluate((root) => root.inert),
    true,
  );
  assert.deepEqual(identities(), before, 'Staged windows do not change reopen ownership');
  await Promise.all([...ids, newId].map((id) => verify(id, cancelled)));
  state.cancelArrangement(cancelled, 'host');
  await Promise.all([...ids, newId].map((id) => finish(id, cancelled, 'cancelled')));
  assert.equal(
    await pages
      .get(newId)
      .locator('#root')
      .evaluate((root) => root.inert),
    true,
  );
  commands.disconnected(newId);
  records.delete(newId);
  await pages.get(newId).close();
  pages.delete(newId);
  state.syncOpenWindows([...records.values()]);
  await checkText(pages.get(targetId));
  assert.deepEqual(identities(), before);

  // Reuse both existing renderers, mount and seal their exact prepared content,
  // then observe the one durable outcome before either resumes editing.
  const committed = 'committed-layout';
  const latest = await seal(committed);
  state.prepareArrangement({
    id: committed,
    ownerId: 'host',
    profileId,
    scope: 'profile',
    changes: originals.map((record, index) => ({ record, ...latest[index], open: true })),
  });
  await Promise.all(ids.map((id, index) => stage(id, committed, originals[index].route)));
  await checkText(pages.get(targetId));
  await Promise.all(ids.map((id) => verify(id, committed)));
  state.commitArrangement(committed, 'host');
  await Promise.all(ids.map((id) => finish(id, committed, 'committed')));
  await checkText(pages.get(targetId));
  for (const id of ids)
    assert.equal(
      await pages
        .get(id)
        .locator('#root')
        .evaluate((root) => root.inert),
      false,
    );
  assert.deepEqual(identities(), before);
  assert.equal(state.arrangementOutcome(committed, 'host'), 'committed');
  await pages.get(targetId).screenshot({ path: '/tmp/puddle-live-layout-handshake.png' });
  console.log(
    'Live layout staging accepts shared dashboard/workspace mounts, rolls back a new pane and adopts an atomic commit.',
  );
}
