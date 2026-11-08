/* global window, performance */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildNativePreview } from '../build.mjs';
import { checkDocking } from './docking.mjs';
import { checkProjectReturns } from './projects.mjs';
import { checkAppInterruptions } from './restart.mjs';

const require = createRequire(import.meta.url);
const { _electron: electron, expect } = createRequire(
  new URL('../../../../../web/package.json', import.meta.url),
)('@playwright/test');
const directory = await mkdtemp(join(tmpdir(), 'puddle-native-transfer-faults-'));
const text = 'Retain this dirty draft through native transfer interruption';
const errors = [];
let application;
const state = async () => JSON.parse(await readFile(join(directory, 'home/reopen-windows.json')));
const launch = async () => {
  application = await electron.launch({
    executablePath: require('electron'),
    args: [join(directory, 'entry.cjs')],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      PUDDLE_NATIVE_TEST_HOME: join(directory, 'home'),
      PREVIEW_URL: process.env.PREVIEW_URL ?? 'http://127.0.0.1:5186/',
    },
  });
  application.on('window', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await application.context().addInitScript(() => performance.setResourceTimingBufferSize(10_000));
  return application.firstWindow();
};
const draft = (page) =>
  page.evaluate(async () => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    return monaco.editor
      .getModels()
      .find((model) => model.uri.scheme === 'puddle' && model.uri.path.endsWith('README.md'))
      ?.getValue();
  });
const arm = (channel, phase = 'before', action = 'hold') =>
  application.evaluate((_electron, fault) => globalThis.nativeTransferFaults.arm(fault), {
    channel: `puddle:window-transfer-${channel}`,
    phase,
    action,
  });
const fault = () => application.evaluate(() => globalThis.nativeTransferFaults.snapshot());
const reached = async () => {
  await expect.poll(async () => (await fault()).reached).not.toBeNull();
  return (await fault()).reached;
};
const detach = async (source) => {
  await source
    .locator('[data-pane-drag-handle]')
    .first()
    .dispatchEvent('contextmenu', { button: 2 });
  const [destination] = await Promise.all([
    application.waitForEvent('window'),
    source.getByRole('menuitem', { name: 'Open pane in window', exact: true }).click(),
  ]);
  return destination;
};
const kill = async () => {
  const closed = application.waitForEvent('close');
  application.process().kill('SIGKILL');
  await closed;
  application = undefined;
};
const quit = async () => {
  const closed = application.waitForEvent('close');
  await application.evaluate(({ app }) => app.quit());
  await closed;
  application = undefined;
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, 'home/native-preview-connections.json'))),
    { starts: 1, closes: 1 },
  );
};
try {
  await buildNativePreview(directory, { transferFaults: true });
  let source = await launch();
  await source
    .locator('[data-release-notes]')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await source
    .locator('[data-sidebar-motion="sessions-item-00000000-0000-4000-8000-000000000001"]')
    .dblclick();
  await source.locator('[data-path="README.md"]').first().dblclick();
  await source.locator('[data-editor-surface] .monaco-editor').first().waitFor();
  await source.evaluate(async (text) => {
    const { monaco } = await import('/src/features/editor/monaco/monaco-setup.ts');
    monaco.editor
      .getModels()
      .find((model) => model.uri.scheme === 'puddle' && model.uri.path.endsWith('README.md'))
      .setValue(text);
  }, text);
  const { identity } = await source.evaluate(() => window.puddleDesktop.windows.context());
  const retained = async (id) =>
    (await state()).entries[id].workspaces['0000000001'].content.buffers.map(
      (buffer) => buffer.content,
    );

  // Destination has mounted its draft but main has not accepted it yet.
  await arm('accept');
  const destination = await detach(source);
  const beforeAccept = await reached();
  await expect.poll(() => draft(destination)).toBe(text);
  const destinationId = (await state()).pending[beforeAccept.id].destinationId;
  const nativeDestination = await application.browserWindow(destination);
  await nativeDestination.evaluate((win) => win.webContents.forcefullyCrashRenderer());
  await expect
    .poll(async () => (await state()).outcomes[beforeAccept.id]?.status)
    .toBe('cancelled');
  await application.evaluate(() => globalThis.nativeTransferFaults.release());
  await expect.poll(() => draft(source)).toBe(text);
  assert.equal((await state()).entries[destinationId].open, false);
  assert.ok((await retained(identity.id)).includes(text));
  console.log('Destination crash before acceptance rolls back without removing the source draft.');

  // Destination is ready; kill the source before its commit reaches the real handler.
  await arm('commit');
  const prepared = await detach(source);
  const beforeCommit = await reached();
  await expect.poll(() => draft(prepared)).toBe(text);
  const nativeSource = await application.browserWindow(source);
  await nativeSource.evaluate((win) => win.webContents.forcefullyCrashRenderer());
  await expect
    .poll(async () => (await state()).outcomes[beforeCommit.id]?.status)
    .toBe('cancelled');
  assert.ok((await retained(identity.id)).includes(text));
  await kill();
  source = await launch();
  await expect.poll(() => application.windows().length).toBe(1);
  await expect.poll(() => draft(source)).toBe(text);
  assert.equal(
    (await source.evaluate(() => window.puddleDesktop.windows.context())).identity.id,
    identity.id,
  );
  console.log(
    'Source crash after destination readiness restores one source window with the same dirty text.',
  );

  // The actual commit succeeds, but its reply is rejected once. Observe; never move twice.
  await arm('commit', 'after', 'reject');
  const committed = await detach(source);
  const lostReply = await reached();
  await expect.poll(async () => (await state()).outcomes[lostReply.id]?.status).toBe('committed');
  await expect
    .poll(
      async () =>
        (await fault()).calls.filter((call) => call.channel === 'puddle:window-transfer-observe')
          .length,
    )
    .toBe(1);
  await expect.poll(() => draft(committed)).toBe(text);
  await expect(
    source.getByRole('button', { name: 'Close README.md', exact: true, includeHidden: true }),
  ).toHaveCount(0);
  const calls = (await fault()).calls;
  assert.equal(calls.filter((call) => call.channel === 'puddle:window-prepare-pane').length, 1);
  assert.equal(calls.filter((call) => call.channel === 'puddle:window-transfer-commit').length, 1);
  assert.equal(Object.keys((await state()).pending).length, 0);
  console.log(
    'Lost commit reply observes one durable outcome without repeating preparation or commit.',
  );
  await checkDocking({
    application,
    host: source,
    pane: committed,
    state,
    draft,
    text,
    arm,
    reached,
    expect,
  });
  await kill();
  source = await launch();
  await expect.poll(() => draft(source)).toBe(text);
  await checkProjectReturns({
    application,
    host: source,
    state,
    draft,
    text,
    arm,
    reached,
    expect,
  });
  await checkAppInterruptions({
    getApplication: () => application,
    host: source,
    state,
    draft,
    text,
    arm,
    reached,
    detach,
    restart: async () => {
      await kill();
      return launch();
    },
    quit,
    launch,
    expect,
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      result: 'passed',
      cases: [
        'destination-before-accept',
        'source-before-commit',
        'lost-commit-reply',
        'dock-source-before-commit',
        'dock-destination-before-accept',
        'project-return-cancel',
        'project-return-lost-accept-reply',
        'quit-during-transfer',
        'app-interruption-before-commit',
        'app-interruption-after-commit',
      ],
    }),
  );
} finally {
  if (application) await kill();
  await rm(directory, { recursive: true, force: true });
}
