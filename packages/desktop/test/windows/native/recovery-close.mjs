/* global window, Response, performance */
import assert from 'node:assert/strict';
import { openFilePane, prepareUntitledClose } from './close.mjs';

export async function checkRecoveryClose(application, project, expect, state) {
  const pane = await openFilePane(application, project, expect, state);
  const mutations = [];
  await pane.exposeFunction('recordRecoveryMutation', (mutation) => {
    mutations.push(mutation);
  });
  const { identity } = await pane.evaluate(() => window.puddleDesktop.windows.context());
  await pane.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    monaco.editor
      .getModels()
      .find((model) => model.uri.scheme === 'puddle')
      .setValue('File text from unavailable project');
  });
  await prepareUntitledClose(pane, expect);
  await pane.evaluate(() => window.nativeDraftClose.releaseWrite());
  await expect
    .poll(() => pane.evaluate(() => window.nativeDraftClose.events))
    .toEqual(['put-start', 'put-done']);
  const editorIds = await pane.evaluate(async () => {
    const loaded = (path) => {
      const entry = performance
        .getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname === path);
      if (!entry) throw new Error(`Live preview module not observed: ${path}`);
      return entry.name;
    };
    const { desktopContentState } = await import(
      loaded('/src/features/windows/state/content-state.ts')
    );
    const { desktopWorkingSet } = await import(
      loaded('/src/features/windows/use-desktop-state.ts')
    );
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const { identity } = await window.puddleDesktop.windows.context();
    const owner = desktopWorkingSet(identity.profileId);
    const content = desktopContentState(identity.profileId);
    await owner.flush();
    const { saveDraft } = await import(loaded('/src/lib/persistence/drafts.ts'));
    await saveDraft(
      '00000000-0000-4000-8000-000000000099',
      'orphan.txt',
      'Independent cached text',
      1,
      '/removed',
    );
    const editorIds = monaco.editor.getEditors().map((editor) => editor.getId());
    content.restore({
      snapshot: owner.get(),
      ...content.capture(owner.get()),
      buffers: [
        ...content.retainedBuffers(),
        {
          session: '00000000-0000-4000-8000-000000000099',
          path: 'orphan.txt',
          root: '/removed',
          content: 'Retained orphan text',
          baseMtimeMs: 1,
        },
      ],
    });
    content.changed();
    await owner.flush();
    const saved = await window.puddleDesktop.windows.read(identity.profileId);
    if (!saved.content.buffers.some((buffer) => buffer.path === 'orphan.txt'))
      throw new Error('Recovery fixture did not persist its orphan in the live window working set');
    return editorIds;
  });
  await expect(pane.getByText('Recovered drafts', { exact: true })).toBeVisible();
  await expect(
    pane.getByRole('textbox', { name: 'Recovered text for orphan.txt', exact: true }),
  ).toHaveValue('Retained orphan text');
  if (process.env.PUDDLE_NATIVE_ORPHAN_SCREENSHOT)
    await pane.screenshot({ path: process.env.PUDDLE_NATIVE_ORPHAN_SCREENSHOT });
  assert.deepEqual(
    await pane.evaluate(async () => {
      const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
      return monaco.editor.getEditors().map((editor) => editor.getId());
    }),
    editorIds,
    'exposing an orphan must keep the healthy workspace editors mounted',
  );
  await pane.evaluate(() => window.puddleDesktop.closeWindow());
  await expect(pane.getByRole('dialog')).toContainText('Discard recovered text for orphan.txt?');
  await pane.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(pane.getByRole('dialog')).toHaveCount(0);

  await pane.evaluate(async () => {
    const loaded = (path) =>
      performance
        .getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname === path)?.name ?? path;
    const { browserTransport } = await import(loaded('/src/lib/transport/browser-transport.ts'));
    const { queryClient } = await import(loaded('/src/lib/queries/client.ts'));
    const transport = browserTransport();
    if (transport?.scope !== 'ui-preview') throw new Error('Requires isolated preview');
    const original = transport.request.bind(transport);
    window.recoveryCloseMutations = [];
    transport.request = async (method, path, body, signal) => {
      const url = new URL(path, window.location.origin).pathname;
      if (method !== 'GET' && (/\/untitled\//.test(url) || /\/file$/.test(url))) {
        window.recoveryCloseMutations.push({ method, url });
        await window.recordRecoveryMutation({ method, url });
      }
      if ((method === 'DELETE' && url.includes('/untitled/')) || url === '/api/projects/0000000002')
        return Response.json(
          { error: { code: 'not_found', message: 'Project/profile no longer exists' } },
          { status: 404 },
        );
      if (method === 'GET' && (url === '/api/projects' || url === '/api/profiles'))
        return Response.json([]);
      return original(method, path, body, signal);
    };
    await Promise.all(
      ['profiles', 'projects'].map((key) => queryClient.resetQueries({ queryKey: [key] })),
    );
    await queryClient.resetQueries({ queryKey: ['project', '0000000002'] });
  });
  const recovery = pane.getByRole('region', { name: 'Unavailable project', exact: true });
  await expect(recovery).toBeVisible();
  await expect(
    recovery.getByRole('textbox', { name: 'Recovered text for package.json', exact: true }),
  ).toHaveValue('File text from unavailable project');
  await expect(
    recovery.getByRole('textbox', { name: 'Recovered text for untitled-1.md', exact: true }),
  ).toHaveValue('Retain this untitled draft');
  if (process.env.PUDDLE_NATIVE_CLOSE_RECOVERY_SCREENSHOT)
    await pane.screenshot({ path: process.env.PUDDLE_NATIVE_CLOSE_RECOVERY_SCREENSHOT });
  await pane.evaluate(() => window.puddleDesktop.closeWindow());
  await expect(pane.getByRole('dialog')).toContainText('Discard recovered text for orphan.txt?');
  await pane.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(
    recovery.getByRole('textbox', { name: 'Recovered text for orphan.txt', exact: true }),
  ).toHaveCount(0);
  await expect(pane.getByRole('dialog')).toContainText('Discard changes to package.json?');
  assert.equal(
    await pane.evaluate(async () => {
      const path = '/src/lib/persistence/drafts.ts';
      const entry = performance
        .getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname === path);
      if (!entry) throw new Error('Draft store module not observed');
      const { loadDraft } = await import(entry.name);
      return (await loadDraft('00000000-0000-4000-8000-000000000099', 'orphan.txt', '/removed'))
        ?.content;
    }),
    'Independent cached text',
  );
  await pane.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(pane.getByRole('dialog')).toHaveCount(0);
  assert.deepEqual(await pane.evaluate(() => window.recoveryCloseMutations), []);
  await expect(
    recovery.getByRole('textbox', { name: 'Recovered text for package.json', exact: true }),
  ).toHaveValue('File text from unavailable project');
  await pane.evaluate(() => window.puddleDesktop.closeWindow());
  await expect(pane.getByRole('dialog')).toContainText('Discard changes to package.json?');
  await pane.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(pane.getByRole('dialog')).toContainText('Discard this draft?');
  await expect(pane.getByRole('dialog')).toContainText('untitled-1.md');
  await Promise.all([
    pane.waitForEvent('close'),
    pane.getByRole('button', { name: 'Discard', exact: true }).click(),
  ]);
  await expect.poll(async () => (await state()).entries[identity.id].open).toBe(false);
  assert.deepEqual(
    (await state()).entries[identity.id].workspaces[identity.profileId].content.buffers,
    [],
  );
  assert.deepEqual(mutations, [
    { method: 'DELETE', url: `/api/profiles/${identity.profileId}/untitled/untitled-1.md` },
  ]);
  console.log(
    'Recovery close retains healthy editors and cancelled text; orphan, file and already-missing draft discard work after project/profile loss.',
  );
}
