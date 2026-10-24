import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadReopenWindows, saveReopenWindows } from '../src/reopen.js';

const mocks = vi.hoisted(() => ({
  home: '',
  startLocal: vi.fn(),
  connectRemote: vi.fn(),
}));

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
    webContents = Object.assign(new EventEmitter(), {
      id: BrowserWindow.windows.length,
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    });
    loadURL = vi.fn().mockResolvedValue(undefined);
    loadFile = vi.fn().mockResolvedValue(undefined);
    show = vi.fn();
    focus = vi.fn();
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

import { app, BrowserWindow, ipcMain } from 'electron';

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
