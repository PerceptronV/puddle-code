/* global window, document */
import assert from 'node:assert/strict';

export async function checkAppInterruptions({
  getApplication,
  host,
  state,
  draft,
  text,
  arm,
  reached,
  detach,
  restart,
  quit,
  launch,
  expect,
}) {
  const { identity } = await host.evaluate(() => window.puddleDesktop.windows.context());
  await arm('commit');
  const staged = await detach(host);
  const pending = await reached();
  await expect.poll(() => draft(staged)).toBe(text);

  // Observe the real quit decision without a modal OS error dialogue blocking the fixture.
  await getApplication().evaluate(({ app, dialog }) => {
    globalThis.nativeQuitErrors = [];
    dialog.showErrorBox = (title, content) => globalThis.nativeQuitErrors.push({ title, content });
    app.quit();
  });
  await expect
    .poll(() => getApplication().evaluate(() => globalThis.nativeQuitErrors))
    .toEqual([
      {
        title: 'Could not save windows before quitting',
        content: 'A window transfer is still pending',
      },
    ]);
  assert.equal(getApplication().windows().length, 2);
  for (const page of [host, staged])
    assert.equal(await page.evaluate(() => document.getElementById('root').inert), true);
  assert.ok((await state()).pending[pending.id]);
  console.log('Quit during a pending transfer is refused while both participants stay fenced.');

  // Kill the app with the uncommitted transfer still prepared on disk.
  host = await restart();
  await expect.poll(() => getApplication().windows().length).toBe(1);
  await expect.poll(() => draft(host)).toBe(text);
  assert.equal(
    (await host.evaluate(() => window.puddleDesktop.windows.context())).identity.id,
    identity.id,
  );
  assert.equal((await state()).outcomes[pending.id].status, 'cancelled');
  assert.equal(Object.keys((await state()).pending).length, 0);
  console.log(
    'App interruption before commit restores only the original owner and its dirty text.',
  );

  // Commit is durable, but the source has not received the reply or removed its live model.
  await arm('commit', 'after');
  const destination = await detach(host);
  const committed = await reached();
  await expect.poll(() => draft(destination)).toBe(text);
  assert.equal((await state()).outcomes[committed.id].status, 'committed');
  assert.equal(await draft(host), text);
  const destinationId = (await destination.evaluate(() => window.puddleDesktop.windows.context()))
    .identity.id;
  await restart();

  const checkOwners = async () => {
    await expect.poll(() => getApplication().windows().length).toBe(2);
    const pages = getApplication().windows();
    const identities = await Promise.all(
      pages.map(async (page) => {
        await page.waitForLoadState('domcontentloaded');
        return (await page.evaluate(() => window.puddleDesktop.windows.context())).identity;
      }),
    );
    assert.deepEqual(
      identities.map((value) => value.id).sort(),
      [identity.id, destinationId].sort(),
    );
    const source = pages[identities.findIndex((value) => value.id === identity.id)];
    const restored = pages[identities.findIndex((value) => value.id === destinationId)];
    await expect.poll(() => draft(restored)).toBe(text);
    await expect(
      source.getByRole('button', { name: 'Close README.md', exact: true, includeHidden: true }),
    ).toHaveCount(0);
    const saved = await state();
    assert.equal(saved.outcomes[committed.id].status, 'committed');
    assert.equal(Object.keys(saved.pending).length, 0);
    assert.deepEqual(saved.entries[identity.id].workspaces['0000000001'].content.buffers, []);
    assert.deepEqual(await getApplication().evaluate(() => globalThis.nativePreviewConnections), {
      starts: 1,
      closes: 0,
    });
  };
  await checkOwners();
  console.log(
    'App interruption after commit restores the destination draft without resurrecting its source tab.',
  );
  await quit();
  await launch();
  await checkOwners();
  console.log(
    'A subsequent clean app quit and relaunch preserves both identities and committed ownership.',
  );
}
