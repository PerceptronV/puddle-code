import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uiStateSnapshotSchema } from '@puddle/shared';
import { loadHostIdentities } from '../src/host-identities.js';
import { loadReopenWindows, saveReopenWindows } from '../src/reopen.js';

const mocks = vi.hoisted(() => ({
  home: '',
  startLocal: vi.fn(),
  connectRemote: vi.fn(),
  loadNativeKeyboard: vi.fn(),
}));

// These tests simulate macOS inside a Node process on every CI platform. The
// native AppKit addon has its own Electron acceptance test and cannot load here.
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  return {
    ...actual,
    createRequire: (filename: string | URL) => {
      const require = actual.createRequire(filename);
      return Object.assign(
        (id: string) =>
          id.endsWith('/command-key-up.node') ? mocks.loadNativeKeyboard(id) : require(id),
        require,
      );
    },
  };
});

vi.mock('@puddle-code/cli/lib', () => ({
  clientHome: () => mocks.home,
  startLocal: mocks.startLocal,
  connectRemote: mocks.connectRemote,
  CliError: class extends Error {},
  daemonUpgradeMessage: vi.fn(),
  applyDesktopUpdate: vi.fn(),
  checkForDesktopUpdate: vi.fn(),
  pruneDesktopUpdateCache: vi.fn().mockResolvedValue(undefined),
  recordDesktopInstallation: vi.fn(),
  stageDesktopUpdate: vi.fn(),
}));
vi.mock('../src/ssh-askpass.js', () => ({
  startSshAskpass: vi.fn().mockResolvedValue({ program: 'askpass', close: vi.fn() }),
}));
vi.mock('../src/notifications.js', () => ({
  DesktopNotifications: class {
    close() {}
  },
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class BrowserWindow extends EventEmitter {
    static windows: BrowserWindow[] = [];
    static getAllWindows = () => BrowserWindow.windows.filter((win) => !win.destroyed);
    destroyed = false;
    currentUrl = '';
    webContents = Object.assign(new EventEmitter(), {
      id: BrowserWindow.windows.length,
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      getURL: () => this.currentUrl,
      isDestroyed: () => this.destroyed,
      reload: vi.fn(() => this.reload()),
      reloadIgnoringCache: vi.fn(() => this.reload()),
    });
    loadURL = vi.fn(async (url: string) => {
      this.currentUrl = url;
      this.webContents.emit('did-start-navigation', {}, url, false, true);
    });
    loadFile = vi.fn().mockResolvedValue(undefined);
    show = vi.fn();
    focus = vi.fn();
    reload() {
      this.webContents.emit('did-start-navigation', {}, this.currentUrl, false, true);
      queueMicrotask(() => this.webContents.emit('did-finish-load'));
    }
    setMenuBarVisibility = vi.fn();
    constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
      super();
      BrowserWindow.windows.push(this);
    }
    getNormalBounds() {
      return { x: 50, y: 60, width: 1200, height: 800 };
    }
    isDestroyed() {
      return this.destroyed;
    }
    close() {
      const event = { preventDefault: vi.fn() };
      this.emit('close', event);
      if (event.preventDefault.mock.calls.length) return;
      this.destroyed = true;
      this.emit('closed');
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  return {
    BrowserWindow,
    app: Object.assign(new EventEmitter(), {
      requestSingleInstanceLock: vi.fn(() => true),
      whenReady: vi.fn().mockResolvedValue(undefined),
      isPackaged: false,
      setName: vi.fn(),
      setAboutPanelOptions: vi.fn(),
      getVersion: () => '0.0.0',
      getPath: () => mocks.home,
      quit: vi.fn(),
      exit: vi.fn(),
      dock: { setMenu: vi.fn() },
    }),
    Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
    dialog: { showErrorBox: vi.fn() },
    ipcMain: Object.assign(new EventEmitter(), { handle: vi.fn() }),
    screen: {
      getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getAllDisplays: () => [],
      getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
    shell: {},
  };
});

import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';

const windows = (BrowserWindow as unknown as { windows: BrowserWindow[] }).windows;
const file = () => join(mocks.home, 'reopen-windows.json');
const targets = () => loadReopenWindows(file()).map((window) => window.target);
const cockpit = (port = 7433) => ({
  origin: `http://localhost:${port}`,
  createInvitation: () => `http://localhost:${port}/#invite=fresh`,
  stop: vi.fn().mockResolvedValue(undefined),
});
const flush = async () => {
  // Drain startup and connection promises without advancing the update timer.
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const boot = async () => {
  await import('../src/main.js');
  await flush();
};
const quit = () => {
  app.emit('before-quit');
  for (const win of BrowserWindow.getAllWindows()) win.close();
  app.emit('will-quit', { preventDefault: vi.fn() });
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal(
    'process',
    Object.defineProperty(Object.create(process), 'platform', { value: 'darwin' }),
  );
  vi.clearAllMocks();
  (app as unknown as EventEmitter).removeAllListeners();
  (ipcMain as unknown as EventEmitter).removeAllListeners();
  windows.length = 0;
  mocks.home = mkdtempSync(join(tmpdir(), 'puddle-window-lifecycle-'));
  mocks.startLocal.mockReset().mockResolvedValue(cockpit());
  mocks.connectRemote.mockReset().mockResolvedValue(cockpit(7434));
  vi.mocked(app.whenReady).mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rmSync(mocks.home, { recursive: true, force: true });
});

describe('desktop quit and reopen lifecycle', () => {
  it('restores multiple windows with one connection and keeps it after the host window closes', async () => {
    saveReopenWindows(file(), [
      { target: 'local', window: { kind: 'host', id: 'host' } },
      {
        target: 'local',
        window: {
          kind: 'project',
          id: 'project',
          profileId: '1234567890',
          projectId: 'abcdef1234',
        },
      },
      {
        target: 'local',
        window: { kind: 'pane', id: 'pane', profileId: '1234567890', projectId: 'abcdef1234' },
      },
    ]);
    await boot();
    expect(BrowserWindow.getAllWindows()).toHaveLength(3);
    expect(mocks.startLocal).toHaveBeenCalledOnce();
    const connection = await mocks.startLocal.mock.results[0]!.value;
    BrowserWindow.getAllWindows()[0].close();
    await flush();
    expect(connection.stop).not.toHaveBeenCalled();
    expect(loadReopenWindows(file()).map((window) => window.window?.kind)).toEqual([
      'project',
      'pane',
    ]);
    quit();
    await flush();
    expect(connection.stop).toHaveBeenCalledOnce();
    expect(loadReopenWindows(file()).map((window) => window.window?.kind)).toEqual([
      'project',
      'pane',
    ]);
  });

  it('restores a pane-only host directly to its project route', async () => {
    saveReopenWindows(file(), [
      {
        target: 'user@host',
        window: {
          kind: 'pane',
          id: 'remote-pane',
          profileId: '1234567890',
          projectId: 'abcdef1234',
        },
      },
    ]);
    await boot();
    expect(BrowserWindow.getAllWindows()).toHaveLength(1);
    expect(BrowserWindow.getAllWindows()[0].loadURL).toHaveBeenCalledWith(
      'http://localhost:7434/project/abcdef1234#invite=fresh',
    );
    expect(mocks.startLocal).not.toHaveBeenCalled();
    expect(mocks.connectRemote).toHaveBeenCalledOnce();
  });

  it('reopens local and SSH windows after Command-Q and keeps their bounds', async () => {
    saveReopenWindows(file(), [{ target: 'local' }, { target: 'user@host' }]);
    await boot();
    expect(BrowserWindow.getAllWindows()).toHaveLength(2);
    quit();
    expect(targets()).toEqual(['local', 'user@host']);
    expect(loadReopenWindows(file())[0].placement?.bounds).toEqual({
      x: 50,
      y: 60,
      width: 1200,
      height: 800,
    });

    vi.resetModules();
    (app as unknown as EventEmitter).removeAllListeners();
    (ipcMain as unknown as EventEmitter).removeAllListeners();
    await boot();
    expect(BrowserWindow.getAllWindows()).toHaveLength(2);
    expect(mocks.startLocal).toHaveBeenCalledTimes(2);
    expect(mocks.connectRemote).toHaveBeenCalledTimes(2);
  });

  it('does not open the picker on macOS activation while saved hosts reconnect', async () => {
    saveReopenWindows(file(), [{ target: 'local' }]);
    const pending = Promise.withResolvers<ReturnType<typeof cockpit>>();
    mocks.startLocal.mockReturnValue(pending.promise);
    await boot();
    app.emit('activate');
    app.emit('second-instance');
    app.emit('window-all-closed');
    expect(BrowserWindow.getAllWindows()).toHaveLength(0);
    expect(app.quit).not.toHaveBeenCalled();
    pending.resolve(cockpit());
    await flush();
    expect(BrowserWindow.getAllWindows()).toHaveLength(1);
  });

  it('keeps pending hosts on early quit and stops connections that finish afterwards', async () => {
    saveReopenWindows(file(), [{ target: 'local' }]);
    const pending = Promise.withResolvers<ReturnType<typeof cockpit>>();
    mocks.startLocal.mockReturnValue(pending.promise);
    await boot();
    quit();
    expect(targets()).toEqual(['local']);

    const late = cockpit();
    pending.resolve(late);
    await flush();
    expect(late.stop).toHaveBeenCalledOnce();
    expect(BrowserWindow.getAllWindows()).toHaveLength(0);
  });

  it('keeps failed hosts for another launch when the fallback picker is closed', async () => {
    saveReopenWindows(file(), [{ target: 'user@host' }]);
    mocks.connectRemote.mockRejectedValue(new Error('Host is offline'));
    await boot();
    expect(BrowserWindow.getAllWindows()).toHaveLength(1);
    BrowserWindow.getAllWindows()[0].close();
    app.emit('window-all-closed');
    quit();
    expect(targets()).toEqual(['user@host']);
  });

  it('keeps an offline host when another restored window opens and then quits', async () => {
    saveReopenWindows(file(), [{ target: 'local' }, { target: 'user@host' }]);
    mocks.connectRemote.mockRejectedValue(new Error('Host is offline'));
    await boot();
    expect(BrowserWindow.getAllWindows()).toHaveLength(1);
    expect(targets()).toEqual(['local', 'user@host']);
    quit();
    expect(targets()).toEqual(['local', 'user@host']);
  });

  it('does not erase unread state or open windows when quit arrives before ready', async () => {
    saveReopenWindows(file(), [{ target: 'local' }]);
    const ready = Promise.withResolvers<void>();
    vi.mocked(app.whenReady).mockReturnValue(ready.promise);
    await boot();
    quit();
    expect(targets()).toEqual(['local']);
    ready.resolve();
    await flush();
    expect(BrowserWindow.getAllWindows()).toHaveLength(0);
    expect(mocks.startLocal).not.toHaveBeenCalled();
  });

  it('remembers newly opened windows before quit and forgets explicit closes', async () => {
    await boot();
    ipcMain.emit('puddle:picker-choose', {}, 'local');
    await flush();
    expect(targets()).toEqual(['local']);
    BrowserWindow.getAllWindows()[0].close();
    expect(targets()).toEqual([]);
    app.emit('window-all-closed');
    quit();
    expect(targets()).toEqual([]);
  });

  it('leaves explicitly closed hosts out of the next Command-Q snapshot', async () => {
    saveReopenWindows(file(), [{ target: 'local' }, { target: 'user@host' }]);
    await boot();
    BrowserWindow.getAllWindows()[1].close();
    expect(targets()).toEqual(['local']);
    quit();
    expect(targets()).toEqual(['local']);
  });

  it('does not let repeated quit events erase the pre-close snapshot', async () => {
    saveReopenWindows(file(), [{ target: 'local' }]);
    await boot();
    quit();
    app.emit('before-quit');
    expect(targets()).toEqual(['local']);
  });
});

it('binds host appearance reports to a registered cockpit main frame and target', async () => {
  saveReopenWindows(file(), [{ target: 'local' }]);
  await boot();
  const win = BrowserWindow.getAllWindows()[0]!;
  const frame = { url: 'http://localhost:7433/project/example' };
  Object.assign(win.webContents, { mainFrame: frame });
  const identity = {
    name: 'Preferred host',
    colour: '#12a6bc',
    icon: [{ tag: 'path', attrs: { d: 'M1 1h20' } }],
  };
  const path = join(mocks.home, 'desktop-host-identities.json');
  ipcMain.emit(
    'puddle:host-identity',
    { sender: win.webContents, senderFrame: { ...frame } },
    identity,
  );
  expect(loadHostIdentities(path).size).toBe(0);
  frame.url = 'https://other.example/';
  ipcMain.emit('puddle:host-identity', { sender: win.webContents, senderFrame: frame }, identity);
  expect(loadHostIdentities(path).size).toBe(0);
  frame.url = 'http://localhost:7433/';
  ipcMain.emit(
    'puddle:host-identity',
    { sender: win.webContents, senderFrame: frame },
    { ...identity, target: 'user@other' },
  );
  expect([...loadHostIdentities(path)]).toEqual([['local', identity]]);
});

it('admits window context only from the registered exact-origin main frame', async () => {
  saveReopenWindows(file(), [{ target: 'local' }]);
  await boot();
  const win = BrowserWindow.getAllWindows()[0]!;
  const frame = { url: 'http://localhost:7433/project/abcdef1234' };
  Object.assign(win.webContents, { mainFrame: frame });
  const context = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([name]) => name === 'puddle:window-context')![1];
  // Minimal Electron event fixture: only these members are consumed by admission.
  const event = { sender: win.webContents, senderFrame: frame } as Electron.IpcMainInvokeEvent;
  expect(context(event).identity.kind).toBe('host');
  expect(() =>
    context({ ...event, senderFrame: { ...frame } } as Electron.IpcMainInvokeEvent),
  ).toThrow('Invalid window sender');
  frame.url = 'http://localhost:7433@evil.example/';
  expect(() => context(event)).toThrow('unavailable');
});

function renderer(win: BrowserWindow) {
  const frame = { url: 'http://localhost:7433/' };
  Object.assign(win.webContents, { mainFrame: frame });
  const event = { sender: win.webContents, senderFrame: frame } as Electron.IpcMainInvokeEvent;
  const handler = (name: string) =>
    vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === name)![1];
  handler('puddle:window-ready')(event);
  return {
    lastCommand: () =>
      vi.mocked(win.webContents.send).mock.calls.at(-1)![1] as {
        id: string;
        kind: string;
      },
    reply: (id: string, error?: string) => handler('puddle:window-reply')(event, { id, error }),
    write: (request: unknown) => handler('puddle:window-write')(event, request),
  };
}

it('holds explicit closure and its connection until the renderer has saved', async () => {
  const connection = cockpit();
  mocks.startLocal.mockResolvedValue(connection);
  saveReopenWindows(file(), [{ target: 'local' }]);
  await boot();
  const win = BrowserWindow.getAllWindows()[0]!;
  const owner = renderer(win);
  win.close();
  expect(win.isDestroyed()).toBe(false);
  expect(connection.stop).not.toHaveBeenCalled();
  expect(owner.lastCommand().kind).toBe('checkpoint');
  owner.reply(owner.lastCommand().id);
  await flush();
  expect(win.isDestroyed()).toBe(true);
  expect(targets()).toEqual([]);
  expect(connection.stop).toHaveBeenCalledOnce();
});

it('retains all quitting windows and accepts state writes while waiting for the last checkpoint', async () => {
  saveReopenWindows(file(), [
    { target: 'local', window: { kind: 'host', id: 'host' } },
    {
      target: 'local',
      window: { kind: 'pane', id: 'pane', profileId: '1234567890', projectId: 'abcdef1234' },
    },
  ]);
  await boot();
  const owners = BrowserWindow.getAllWindows().map(renderer);
  const event = { preventDefault: vi.fn() };
  app.emit('before-quit', event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  const saved = owners[0]!.write({
    profileId: '1234567890',
    revision: 0,
    content: {
      snapshot: uiStateSnapshotSchema.parse({}),
      buffers: [{ session: 's', path: 'a.ts', content: 'last edit', baseMtimeMs: 1 }],
      views: {},
    },
  });
  expect(saved.revision).toBe(1);
  owners[0]!.reply(owners[0]!.lastCommand().id);
  await flush();
  expect(app.quit).not.toHaveBeenCalled();
  expect(BrowserWindow.getAllWindows()).toHaveLength(2);
  owners[1]!.reply(owners[1]!.lastCommand().id);
  await flush();
  expect(app.quit).toHaveBeenCalledOnce();
  for (const win of BrowserWindow.getAllWindows()) win.close();
  expect(targets()).toEqual(['local', 'local']);
});

it('cancels quit after a failed save and releases the interaction fence in every window', async () => {
  saveReopenWindows(file(), [{ target: 'local' }]);
  await boot();
  const win = BrowserWindow.getAllWindows()[0]!;
  const owner = renderer(win);
  app.emit('before-quit', { preventDefault: vi.fn() });
  owner.reply(owner.lastCommand().id, 'Disk is full');
  await flush();
  expect(owner.lastCommand().kind).toBe('resume');
  owner.reply(owner.lastCommand().id);
  await flush();
  expect(app.quit).not.toHaveBeenCalled();
  expect(win.isDestroyed()).toBe(false);
  expect(dialog.showErrorBox).toHaveBeenCalledWith(
    'Could not save windows before quitting',
    'Disk is full',
  );
  // A fresh user attempt is admitted after cancellation.
  app.emit('before-quit', { preventDefault: vi.fn() });
  expect(owner.lastCommand().kind).toBe('checkpoint');
  owner.reply(owner.lastCommand().id);
  await flush();
  expect(app.quit).toHaveBeenCalledOnce();
});

it('opens a staged native pane on the same connection and preserves it after its host closes', async () => {
  saveReopenWindows(file(), [{ target: 'local' }]);
  await boot();
  const source = BrowserWindow.getAllWindows()[0]!;
  const sourceRenderer = renderer(source);
  const profileId = '1234567890';
  const content = {
    snapshot: uiStateSnapshotSchema.parse({
      layout_mode: 'profile',
      layout_tree: { kind: 'leaf', id: 'pane', tabs: [], activeKey: null },
    }),
    buffers: [{ session: 's', path: 'a.ts', content: 'draft', baseMtimeMs: 1 }],
    views: {},
  };
  sourceRenderer.write({ profileId, revision: 0, content });
  const invoke = (win: BrowserWindow, channel: string, value: unknown) => {
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)![1];
    return handler(
      {
        sender: win.webContents,
        senderFrame: win.webContents.mainFrame,
      } as Electron.IpcMainInvokeEvent,
      value,
    );
  };
  const reference = { id: 'move', profileId };
  const preparation = invoke(source, 'puddle:window-prepare-pane', {
    ...reference,
    projectId: 'abcdef1234',
    revision: 1,
    source: { ...content, buffers: [] },
    destination: content,
  });
  await flush();
  const destination = BrowserWindow.getAllWindows()[1]!;
  renderer(destination);
  expect(mocks.startLocal).toHaveBeenCalledOnce();
  expect(invoke(destination, 'puddle:window-context', undefined).stagingTransfer).toBe('move');
  expect(invoke(destination, 'puddle:window-read', { profileId }).content.buffers).toEqual(
    content.buffers,
  );
  // Prepared destinations are not in the reopen set until both renderers accept.
  expect(targets()).toEqual(['local']);
  const acceptance = invoke(destination, 'puddle:window-transfer-accept', reference);
  await preparation;
  invoke(source, 'puddle:window-transfer-commit', reference);
  expect((await acceptance).content.buffers).toEqual(content.buffers);
  expect(targets()).toEqual(['local', 'local']);
  source.close();
  sourceRenderer.reply(sourceRenderer.lastCommand().id);
  await flush();
  expect(BrowserWindow.getAllWindows()).toEqual([destination]);
  expect(targets()).toEqual(['local']);
  expect(loadReopenWindows(file())[0]?.window?.kind).toBe('pane');
});

function twoWindows() {
  saveReopenWindows(file(), [
    { target: 'local', window: { kind: 'host', id: 'host' } },
    {
      target: 'local',
      window: { kind: 'pane', id: 'pane', profileId: '1234567890', projectId: 'abcdef1234' },
    },
  ]);
}
function refresh() {
  mocks.startLocal.mock.calls[0]![0].onRefreshRequest('refresh-id');
}
function menuItem(label: string): Electron.MenuItemConstructorOptions {
  const visit = (
    items: Electron.MenuItemConstructorOptions[],
  ): Electron.MenuItemConstructorOptions | undefined => {
    for (const item of items) {
      if (item.label === label) return item;
      if (Array.isArray(item.submenu)) {
        const found = visit(item.submenu);
        if (found) return found;
      }
    }
  };
  for (const [template] of vi.mocked(Menu.buildFromTemplate).mock.calls) {
    const found = visit(template);
    if (found) return found;
  }
  throw new Error(`Missing menu item ${label}`);
}

it('checkpoints every sibling before one correlated refresh and resumes surviving same-origin windows', async () => {
  twoWindows();
  await boot();
  const old = await mocks.startLocal.mock.results[0]!.value;
  const owners = BrowserWindow.getAllWindows().map(renderer);
  refresh();
  refresh();
  await flush();
  expect(owners.map((owner) => owner.lastCommand().kind)).toEqual(['checkpoint', 'checkpoint']);
  owners[0]!.reply(owners[0]!.lastCommand().id);
  await flush();
  expect(old.stop).not.toHaveBeenCalled();
  owners[1]!.reply(owners[1]!.lastCommand().id);
  await flush();
  expect(old.stop).toHaveBeenCalledOnce();
  expect(mocks.startLocal).toHaveBeenCalledTimes(2);
  for (const owner of owners) {
    expect(owner.lastCommand().kind).toBe('resume');
    owner.reply(owner.lastCommand().id);
  }
  await flush();
  expect(BrowserWindow.getAllWindows()).toHaveLength(2);
  expect(dialog.showErrorBox).not.toHaveBeenCalled();
});

it('leaves the original host connected when any sibling cannot checkpoint', async () => {
  twoWindows();
  await boot();
  const old = await mocks.startLocal.mock.results[0]!.value;
  const owners = BrowserWindow.getAllWindows().map(renderer);
  refresh();
  await flush();
  owners[0]!.reply(owners[0]!.lastCommand().id, 'Disk is full');
  await flush();
  expect(owners[1]!.lastCommand().kind).toBe('checkpoint');
  owners[1]!.reply(owners[1]!.lastCommand().id);
  await flush();
  for (const owner of owners) {
    expect(owner.lastCommand().kind).toBe('resume');
    owner.reply(owner.lastCommand().id);
  }
  await flush();
  expect(old.stop).not.toHaveBeenCalled();
  expect(mocks.startLocal).toHaveBeenCalledOnce();
  expect(dialog.showErrorBox).toHaveBeenCalledWith('Could not refresh this host', 'Disk is full');
});

it.each(['Reload', 'Force Reload'])(
  'checkpoints the focused window before native %s',
  async (label) => {
    saveReopenWindows(file(), [{ target: 'local' }]);
    await boot();
    const win = BrowserWindow.getAllWindows()[0]!;
    const owner = renderer(win);
    const item = menuItem(label);
    item.click!(item as Electron.MenuItem, win, {} as Electron.KeyboardEvent);
    await flush();
    expect(owner.lastCommand().kind).toBe('checkpoint');
    expect(win.webContents.reload).not.toHaveBeenCalled();
    expect(win.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
    owner.reply(owner.lastCommand().id);
    await flush();
    expect(
      label === 'Reload' ? win.webContents.reload : win.webContents.reloadIgnoringCache,
    ).toHaveBeenCalledOnce();
    expect(mocks.startLocal).toHaveBeenCalledOnce();
  },
);

it('lets Command-Q cancel an unsent refresh, drain its fences, then checkpoint for quit', async () => {
  twoWindows();
  await boot();
  const owners = BrowserWindow.getAllWindows().map(renderer);
  refresh();
  await flush();
  const event = { preventDefault: vi.fn() };
  app.emit('before-quit', event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  for (const owner of owners) owner.reply(owner.lastCommand().id);
  await flush();
  for (const owner of owners) {
    expect(owner.lastCommand().kind).toBe('resume');
    owner.reply(owner.lastCommand().id);
  }
  await flush();
  expect(mocks.startLocal).toHaveBeenCalledOnce();
  expect(app.quit).not.toHaveBeenCalled();
  for (const owner of owners) {
    expect(owner.lastCommand().kind).toBe('checkpoint');
    owner.reply(owner.lastCommand().id);
  }
  await flush();
  expect(app.quit).toHaveBeenCalledOnce();
  expect(dialog.showErrorBox).not.toHaveBeenCalled();
});
