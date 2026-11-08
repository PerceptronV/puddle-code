import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { uiStateSnapshotSchema } from '@puddle/shared';
import { DesktopWindowState } from '../../src/windows/persistence/state.js';
import { registerWindowStateIpc } from '../../src/windows/ipc.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('desktop window state IPC', () => {
  it('binds reads and writes to the registered sender and checks authority first', () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-window-ipc-'));
    homes.push(home);
    const state = new DesktopWindowState(join(home, 'state.json'));
    state.syncOpenWindows([
      { target: 'local', window: { id: 'sender', kind: 'host' } },
      { target: 'remote', window: { id: 'victim', kind: 'host' } },
    ]);
    const handle = vi.fn();
    let admitted = true;
    registerWindowStateIpc({
      ipc: { handle },
      context: () => {
        if (!admitted) throw new Error('Invalid window sender');
        return { identity: { kind: 'host', id: 'sender' }, hostId: 'local-host' };
      },
      state: () => state,
    });
    // The callbacks' event is deliberately opaque: sender admission is the
    // injected main-process boundary, before request parsing or store access.
    const event = {} as IpcMainInvokeEvent;
    const write = handle.mock.calls.find(([name]) => name === 'puddle:window-write')![1];
    const read = handle.mock.calls.find(([name]) => name === 'puddle:window-read')![1];
    const content = { snapshot: uiStateSnapshotSchema.parse({}), buffers: [], views: {} };
    expect(
      write(event, {
        profileId: '1234567890',
        revision: 0,
        content,
        windowId: 'victim',
        target: 'remote',
      }).revision,
    ).toBe(1);
    expect(read(event, { profileId: '1234567890', windowId: 'victim' }).revision).toBe(1);
    expect(state.read('victim', '1234567890')).toBeNull();
    admitted = false;
    expect(() => read(event, null)).toThrow('Invalid window sender');
    expect(() => write(event, null)).toThrow('Invalid window sender');
  });
});
