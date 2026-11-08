/* global window, document */
import assert from 'node:assert/strict';

export async function checkProjectReturns({
  application,
  host,
  state,
  draft,
  text,
  arm,
  reached,
  expect,
}) {
  await host.evaluate(async () =>
    (await import('/src/features/windows/navigation/project-actions.ts')).navigateProjectRoute('/'),
  );
  await host
    .locator('a[href="/project/0000000002"]')
    .first()
    .dispatchEvent('contextmenu', { button: 2 });
  const [project] = await Promise.all([
    application.waitForEvent('window'),
    host.getByRole('menuitem', { name: 'Open project in window', exact: true }).click(),
  ]);
  await expect.poll(() => draft(project)).toBe(text);
  await expect.poll(async () => Object.keys((await state()).pending).length).toBe(0);
  const { identity } = await project.evaluate(() => window.puddleDesktop.windows.context());
  const beginReturn = async () => {
    await project
      .locator('[data-sidebar-motion="sessions-project-0000000002"]')
      .dispatchEvent('contextmenu', { button: 2 });
    await project.getByRole('menuitem', { name: 'Return project to host', exact: true }).click();
  };

  // The project has released its models, but cancellation must remount its draft.
  await arm('commit');
  await beginReturn();
  const cancelled = await reached();
  await expect.poll(() => draft(host)).toBe(text);
  const outcome = await project.evaluate(
    (reference) => window.puddleDesktop.windows.transfers.cancel(reference),
    { id: cancelled.id, profileId: identity.profileId },
  );
  assert.equal(outcome.status, 'cancelled');
  await application.evaluate(() => globalThis.nativeTransferFaults.release());
  await expect.poll(() => draft(project)).toBe(text);
  await expect
    .poll(() => project.evaluate(() => document.getElementById('root').inert))
    .toBe(false);
  await expect.poll(() => host.evaluate(() => window.location.pathname)).toBe('/');
  assert.equal((await state()).entries[identity.id].open, true);
  console.log(
    'Cancelled project return remounts the source draft and restores the host dashboard.',
  );

  // The source closes durably while the destination loses its acceptance reply.
  await arm('accept', 'after', 'reject');
  const closed = project.waitForEvent('close');
  await beginReturn();
  const lostReply = await reached();
  await closed;
  await expect.poll(async () => (await state()).outcomes[lostReply.id]?.status).toBe('committed');
  assert.equal((await state()).entries[identity.id].open, false);
  await expect.poll(() => draft(host)).toBe(text);
  await expect.poll(() => host.evaluate(() => document.getElementById('root').inert)).toBe(false);
  const calls = await application.evaluate(() => globalThis.nativeTransferFaults.snapshot().calls);
  for (const operation of ['accept', 'commit', 'observe'])
    assert.equal(
      calls.filter((call) => call.channel === `puddle:window-transfer-${operation}`).length,
      1,
    );
  await host
    .getByRole('button', { name: 'Close README.md', exact: true, includeHidden: true })
    .focus();
  await host.keyboard.press('Enter');
  const review = host.getByRole('dialog');
  await expect(review.getByRole('button', { name: 'Discard', exact: true })).toBeVisible();
  await review.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect.poll(() => draft(host)).toBe(text);
  assert.equal(Object.keys((await state()).pending).length, 0);
  console.log(
    'Lost destination acceptance reply leaves the returned project editable in its host.',
  );
}
