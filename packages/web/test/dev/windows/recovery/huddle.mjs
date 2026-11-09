/* global window, performance, Response */
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

/** Exercise missing-placement/project recovery through the real window working set. */
export async function checkHuddleRecovery(page, profileId) {
  const paths = await page.evaluate(async (profile) => {
    const loaded = (path) =>
      performance
        .getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname === path)?.name ?? path;
    const { desktopContentState } = await import(
      loaded('/src/features/windows/state/content-state.ts')
    );
    const { desktopWorkingSet } = await import(
      loaded('/src/features/windows/use-desktop-state.ts')
    );
    const { browserTransport } = await import(loaded('/src/lib/transport/browser-transport.ts'));
    const { queryClient } = await import(loaded('/src/lib/queries/client.ts'));
    const transport = browserTransport();
    if (transport?.scope !== 'ui-preview') throw new Error('Requires the UI-only preview');
    const original = transport.request.bind(transport);
    let missingProject = false;
    window.huddleRecoveryMutations = [];
    transport.request = (method, path, ...rest) => {
      if (method !== 'GET') window.huddleRecoveryMutations.push({ method, path });
      if (missingProject && method === 'GET' && path === '/api/projects/0000000002')
        return Promise.resolve(
          Response.json(
            { error: { code: 'not_found', message: 'Project unavailable' } },
            { status: 404 },
          ),
        );
      if (
        missingProject &&
        method === 'GET' &&
        (path.startsWith('/api/projects?') || path === '/api/projects' || path === '/api/profiles')
      )
        return Promise.resolve(Response.json([]));
      return original(method, path, ...rest);
    };
    const owner = desktopWorkingSet(profile);
    await owner.flush();
    window.removeHuddleRecoveryProject = async () => {
      missingProject = true;
      await Promise.all(
        ['profiles', 'projects'].map((key) => queryClient.resetQueries({ queryKey: [key] })),
      );
      await queryClient.resetQueries({ queryKey: ['project', '0000000002'] });
    };
    window.closeRecoveryHuddleByAction = async () => {
      const { getHotkeyHandler } = await import(loaded('/src/lib/navigation/hotkeys.ts'));
      const close = getHotkeyHandler('tab.close');
      if (!close) throw new Error('Missing close-tab action');
      close();
    };
    // The synthetic shell now advertises the capability supported by its real state store.
    window.puddleDesktop.windows.huddles = 1;
    const session = '00000000-0000-4000-8000-000000000098';
    const root = `.puddle/huddle/${'a'.repeat(32)}`;
    const paths = [`${root}/huddle.json`, `${root}/layout.json`];
    const snapshot = {
      ...owner.get(),
      layout_mode: 'profile',
      project_layouts: {},
      active_session: session,
      layout_tree: {
        kind: 'leaf',
        id: 'huddle-recovery',
        tabs: [{ type: 'huddle', session }],
        activeKey: `huddle:${session}`,
      },
    };
    const content = desktopContentState(profile);
    content.restore({
      snapshot,
      ...content.capture(owner.get()),
      buffers: [
        ...content.retainedBuffers(),
        ...paths.map((path, index) => ({
          session,
          path,
          content: index ? 'Unsaved huddle layout' : 'Unsaved huddle graph',
          baseMtimeMs: 1,
        })),
      ],
    });
    owner.update(snapshot);
    content.changed();
    await owner.flush();
    return paths;
  }, profileId);
  const missing = page.getByRole('region', { name: 'Unavailable huddle', exact: true });
  for (const [index, path] of paths.entries())
    await expect(
      missing.getByRole('textbox', { name: `Recovered text for ${path}`, exact: true }),
    ).toHaveValue(index ? 'Unsaved huddle layout' : 'Unsaved huddle graph');
  await page
    .locator('[data-pane-tab="huddle:00000000-0000-4000-8000-000000000098"]')
    .hover({ position: { x: 150, y: 3 } });
  await page.getByRole('button', { name: 'Close Huddle 00000000', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Keep editing', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.evaluate(() => window.closeRecoveryHuddleByAction());
  await page.getByRole('dialog').getByRole('button', { name: 'Keep editing', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await expect(missing.getByRole('textbox')).toHaveCount(2);
  await page.evaluate(() => window.removeHuddleRecoveryProject());
  const recovery = page.getByRole('region', { name: 'Unavailable project', exact: true });
  await expect(
    recovery.getByRole('textbox', { name: `Recovered text for ${paths[0]}`, exact: true }),
  ).toHaveValue('Unsaved huddle graph');
  await expect(
    recovery.getByRole('textbox', { name: `Recovered text for ${paths[1]}`, exact: true }),
  ).toHaveValue('Unsaved huddle layout');
  const group = recovery.getByRole('region', { name: 'Huddle 00000000', exact: true });
  const downloads = group.getByRole('button', { name: 'Download recovered text', exact: true });
  assert.equal(await downloads.count(), 2);
  const download = page.waitForEvent('download');
  await downloads.first().click();
  assert.equal((await download).suggestedFilename(), 'huddle.json');
  await group.getByRole('button', { name: 'Close Huddle 00000000', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(group.getByRole('textbox')).toHaveCount(2);
  await group.getByRole('button', { name: 'Close Huddle 00000000', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(group).toHaveCount(0);
  for (const path of paths)
    await expect(
      recovery.getByRole('textbox', { name: `Recovered text for ${path}`, exact: true }),
    ).toHaveCount(0);
  await expect(
    recovery.getByRole('textbox', { name: 'Recovered text for README.md', exact: true }),
  ).toHaveValue('Latest unsaved edit checkpointed before native reload');
  assert.deepEqual(
    await page.evaluate(() =>
      window.huddleRecoveryMutations.filter(({ path }) => /\/file\b|\/huddle\//.test(path)),
    ),
    [],
  );
  console.log(
    'Missing-placement/project huddle drafts stay visible and downloadable; tab/action close and grouped discard preserve review.',
  );
}
