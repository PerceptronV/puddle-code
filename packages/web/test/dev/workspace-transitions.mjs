/* global window, document */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.stack);
  });
  await page.goto(
    new URL('/test/dev/workspace-fixture.html', process.env.PREVIEW_URL ?? 'http://localhost:5174/')
      .href,
  );
  await page.waitForSelector('.monaco-editor');
  assert.equal(
    await page.evaluate(() => window.workspaceFixture.state().layout_mode),
    'profile',
    'conversion waits for full project catalogue',
  );
  await page.evaluate(() => window.workspaceFixture.releaseProjects());
  await page.waitForFunction(() => window.workspaceFixture.state().layout_mode === 'project');
  const initial = await page.evaluate(() => window.workspaceFixture.state());
  assert.equal(Object.keys(initial.project_layouts).length, 2);
  await page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    const model = monaco.editor.getModels().find((m) => m.uri.path.endsWith('README.md'));
    model.setValue('Synthetic dirty text preserved across projects');
    window.workspaceFixture.save();
    window.workspaceFixture.visit(
      window.workspaceFixture.first,
      window.workspaceFixture.sessions[0],
    );
  });
  await page.waitForSelector('[data-notification-session="00000000-0000-4000-8000-000000000001"]');
  await page.evaluate(() => {
    window.firstTerminal = document.querySelector(
      '[data-notification-session="00000000-0000-4000-8000-000000000001"]',
    );
    window.workspaceFixture.visit(
      window.workspaceFixture.second,
      window.workspaceFixture.sessions[1],
    );
  });
  await page.waitForSelector('[data-notification-session="00000000-0000-4000-8000-000000000002"]');
  assert.equal(
    await page.evaluate(() => window.firstTerminal.isConnected),
    true,
    'parked terminal remains mounted',
  );
  await page.evaluate(() =>
    window.workspaceFixture.visit(
      window.workspaceFixture.first,
      window.workspaceFixture.sessions[0],
    ),
  );
  await page.waitForSelector('[data-notification-session="00000000-0000-4000-8000-000000000001"]');
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector(
          '[data-notification-session="00000000-0000-4000-8000-000000000001"]',
        ) === window.firstTerminal,
    ),
    true,
  );
  await page
    .locator('[data-pane-drag-handle] [aria-roledescription="draggable"]')
    .filter({ hasText: 'README.md' })
    .click();
  await page.waitForSelector('.monaco-editor');
  assert.equal(
    await page.evaluate(async () => {
      const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
      return monaco.editor
        .getModels()
        .find((m) => m.uri.path.endsWith('README.md'))
        .getValue();
    }),
    'Synthetic dirty text preserved across projects',
  );
  await page.evaluate(() => window.workspaceFixture.projectMode(false));
  await page.waitForFunction(() => window.workspaceFixture.state().layout_mode === 'profile');
  assert.equal(await page.evaluate(() => window.firstTerminal.isConnected), true);
  assert.equal(await page.evaluate(() => window.workspaceFixture.load()), true);
  await page.waitForFunction(() => window.workspaceFixture.state().layout_mode === 'project');
  assert.equal(await page.evaluate(() => window.workspaceFixture.bridge().scope), 'project');
  const restored = await page.evaluate(() => window.workspaceFixture.state());
  assert.ok(
    restored.project_layouts['0000000003'].layout_tree,
    'loading one project preserves another project slice',
  );
  assert.equal(await page.evaluate(() => window.firstTerminal.isConnected), true);
  await page.evaluate(async () => {
    const { updateClientSettings } = await import('/src/lib/settings/client-settings.ts');
    updateClientSettings({ showAllProjectSessions: false, reduceMotion: false });
    window.workspaceFixture.visit(
      window.workspaceFixture.first,
      window.workspaceFixture.sessions[0],
    );
  });
  await page.waitForTimeout(250);
  for (let mode = 0; mode < 2; mode++) {
    await page.waitForFunction(() => {
      const accordion = document.querySelector(
        `[data-session-project="${window.workspaceFixture.second}"] [data-session-accordion]`,
      );
      return accordion?.inert && accordion.getBoundingClientRect().height < 1;
    });
    const samples = await page.evaluate(async () => {
      const fixture = window.workspaceFixture;
      const accordion = document.querySelector(
        `[data-session-project="${fixture.second}"] [data-session-accordion]`,
      );
      const before = accordion.getBoundingClientRect().height;
      fixture.visit(fixture.second, fixture.sessions[1]);
      // Navigation can wait on query data. Sample the transition once the actual
      // group has opened, independent of machine load and network scheduling.
      for (let frame = 0; accordion.inert && frame < 120; frame++)
        await new Promise(window.requestAnimationFrame);
      accordion.getBoundingClientRect();
      const transitions = accordion.getAnimations();
      for (const animation of transitions) {
        animation.pause();
        animation.currentTime = 100;
      }
      const middle = accordion.getBoundingClientRect().height;
      for (const animation of transitions) animation.finish();
      await new Promise(window.requestAnimationFrame);
      return {
        before,
        middle,
        after: accordion.getBoundingClientRect().height,
        retained: accordion.isConnected,
        inert: accordion.inert,
      };
    });
    assert.ok(samples.before < 1, 'inactive project is folded');
    assert.ok(
      samples.middle > 0 && samples.middle < samples.after,
      'project sessions unfold through intermediate heights',
    );
    assert.equal(samples.retained, true);
    assert.equal(samples.inert, false);
    await page.evaluate(() =>
      window.workspaceFixture.visit(
        window.workspaceFixture.first,
        window.workspaceFixture.sessions[0],
      ),
    );
    await page.waitForTimeout(250);
    if (mode === 0) {
      const hide = page.getByRole('button', { name: 'Hide sessions', exact: true });
      if (await hide.isVisible()) await hide.click();
      else await page.getByRole('button', { name: 'Show sessions', exact: true }).click();
      await page.waitForTimeout(350);
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'Real workspace preserves terminal portals and dirty buffers through project visits, delayed catalogue, mode conversion and saved-layout loading.',
  );
} finally {
  await browser.close();
}
