import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@puddle/shared';
import { reviewedHostUpdate } from '../../../shared/test/helpers/host-update.js';
vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() } }));
import { dialog } from 'electron';
import { hostUpdateApprovals } from '../../src/host-updates/approval.js';
afterEach(() => vi.resetAllMocks());

it('requires a second explicit desktop decision with exact work counts and cancellation by default', async () => {
  vi.mocked(dialog.showMessageBox)
    .mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    .mockResolvedValueOnce({ response: 1, checkboxChecked: false });
  const callbacks = hostUpdateApprovals({
    host: 'alice@fixture',
    parent: () => undefined,
    active: () => true,
  });
  expect(
    await callbacks.confirmDaemonUpgrade({
      host: 'alice@fixture',
      daemon: { version: '0.3.99', protocol: { major: 25, minor: 20 } },
      clientProtocol: PROTOCOL_VERSION,
      liveSessions: 6,
    }),
  ).toBe(true);
  expect(await callbacks.confirmInterruption(reviewedHostUpdate())).toBe(false);
  expect(dialog.showMessageBox).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      detail: expect.stringContaining('separate exact interruption review'),
      defaultId: 1,
      cancelId: 1,
    }),
  );
  expect(dialog.showMessageBox).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      detail: expect.stringContaining(
        '2 daemon-owned terminal(s), 1 notebook kernel(s), 3 compilation task(s) and 4 programme(s)',
      ),
      buttons: ['Interrupt and update', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    }),
  );
});
it('rejects a delayed desktop approval after its shell closes', async () => {
  let active = true;
  let answer!: (value: Electron.MessageBoxReturnValue) => void;
  vi.mocked(dialog.showMessageBox).mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const callbacks = hostUpdateApprovals({
    host: 'fixture',
    parent: () => undefined,
    active: () => active,
  });
  const pending = callbacks.confirmInterruption(reviewedHostUpdate());
  active = false;
  answer({ response: 0, checkboxChecked: false });
  expect(await pending).toBe(false);
  expect(await callbacks.confirmInterruption(reviewedHostUpdate())).toBe(false);
  expect(dialog.showMessageBox).toHaveBeenCalledOnce();
});

it('rejects a delayed approval when its parent host window is destroyed', async () => {
  let destroyed = false;
  const parent = { isDestroyed: () => destroyed } as Electron.BrowserWindow;
  let answer!: (value: Electron.MessageBoxReturnValue) => void;
  vi.mocked(dialog.showMessageBox).mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const callbacks = hostUpdateApprovals({
    host: 'fixture',
    parent: () => parent,
    active: () => true,
  });
  const pending = callbacks.confirmInterruption(reviewedHostUpdate());
  destroyed = true;
  answer({ response: 0, checkboxChecked: false });
  expect(await pending).toBe(false);
});
