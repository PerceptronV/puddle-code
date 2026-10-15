import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class BrowserWindow extends EventEmitter {
    static windows: BrowserWindow[] = [];
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { send: vi.fn() });
    show = vi.fn();
    focus = vi.fn();
    setMenuBarVisibility = vi.fn();
    loadFile = vi.fn().mockResolvedValue(undefined);
    constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
      super();
      // Even during replacement, there must never be two live auth windows.
      expect(BrowserWindow.windows.every((win) => win.destroyed)).toBe(true);
      BrowserWindow.windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  return { BrowserWindow, ipcMain: new EventEmitter() };
});

import { BrowserWindow, ipcMain } from 'electron';
import { createSshAuthPrompter } from '../src/ssh-auth-prompt.js';

// Extra inspection surface on the Electron test double, not production API.
const windows = (BrowserWindow as unknown as { windows: BrowserWindow[] }).windows;
const options = (win: BrowserWindow) =>
  (win as unknown as { options: Electron.BrowserWindowConstructorOptions }).options;
const request = (target = 'user@host') => ({
  target,
  prompt: 'Password:',
  kind: 'secret' as const,
});
let prompter: ReturnType<typeof createSshAuthPrompter>;
const isHostOpen = vi.fn((_target: string) => true);
const parent = vi.fn((_target: string): BrowserWindow | null => null);
const prompt = (target?: string, controller = new AbortController()) =>
  prompter.prompt(request(target), controller.signal);
const submit = (win: BrowserWindow, answer: string) =>
  ipcMain.emit('puddle:ssh-auth-submit', { sender: win.webContents }, answer);

beforeEach(() => {
  windows.length = 0;
  isHostOpen.mockReset().mockReturnValue(true);
  parent.mockReset().mockReturnValue(null);
  prompter = createSshAuthPrompter({
    htmlPath: 'auth.html',
    preloadPath: 'auth.cjs',
    isHostOpen,
    parent,
  });
});
afterEach(() => prompter.close());

describe('SSH authentication prompt lifetime', () => {
  it('attaches each prompt to its target host window and names the host', async () => {
    const owner = { isDestroyed: () => false } as BrowserWindow;
    parent.mockImplementation((target) => (target === 'user@first' ? owner : null));
    const first = prompt('user@first');
    const second = prompt('user@second');
    expect(parent).toHaveBeenCalledWith('user@first');
    expect(options(windows[0])).toMatchObject({
      parent: owner,
      modal: true,
      title: 'SSH Authentication — user@first',
    });
    submit(windows[0], 'first answer');
    expect(await first).toBe('first answer');
    expect(parent).toHaveBeenLastCalledWith('user@second');
    expect(options(windows[1]).parent).toBeUndefined();
    expect(options(windows[1]).title).toBe('SSH Authentication — user@second');
    submit(windows[1], 'second answer');
    expect(await second).toBe('second answer');
  });

  it('allows successive confirmation, password and 2FA steps for the same host', async () => {
    for (const [index, step] of [
      { ...request(), prompt: 'Trust this host?', kind: 'confirm' as const },
      request(),
      { ...request(), prompt: 'Verification code:' },
    ].entries()) {
      const controller = new AbortController();
      const answer = prompter.prompt(step, controller.signal);
      windows[index].webContents.emit('did-finish-load');
      expect(windows[index].webContents.send).toHaveBeenCalledWith('puddle:ssh-auth-request', step);
      submit(windows[index], `answer ${index}`);
      expect(await answer).toBe(`answer ${index}`);
      controller.abort();
    }
    expect(windows).toHaveLength(3);
    expect(windows.every((win) => win.isDestroyed())).toBe(true);
  });

  it('destroys an older same-host prompt before opening its replacement', async () => {
    const old = prompt();
    const stale = windows[0];
    const latest = prompt();
    expect(await old).toBeNull();
    expect(stale.isDestroyed()).toBe(true);
    stale.webContents.emit('did-finish-load');
    expect(stale.show).not.toHaveBeenCalled();
    // Delayed renderer events cannot submit to or close the new request.
    submit(stale, 'stale answer');
    stale.emit('closed');
    expect(windows[1].isDestroyed()).toBe(false);
    submit(windows[1], 'current answer');
    expect(await latest).toBe('current answer');
  });

  it('bounds the queue per target without conflating identical prompts from different hosts', async () => {
    const first = prompt('user@first');
    const attempts = Array.from({ length: 50 }, () => prompt('user@second'));
    expect(windows).toHaveLength(1);
    expect(await Promise.all(attempts.slice(0, -1))).toEqual(Array(49).fill(null));
    submit(windows[0], 'first answer');
    expect(await first).toBe('first answer');
    expect(windows).toHaveLength(2);
    windows[1].webContents.emit('did-finish-load');
    expect(windows[1].webContents.send).toHaveBeenCalledWith(
      'puddle:ssh-auth-request',
      request('user@second'),
    );
    submit(windows[1], 'second answer');
    expect(await attempts[49]).toBe('second answer');
  });

  it('keeps only one live window through a burst of same-host reconnect requests', async () => {
    const controllers = Array.from({ length: 100 }, () => new AbortController());
    const attempts = controllers.map((controller) => prompt('user@host', controller));
    expect(await Promise.all(attempts.slice(0, -1))).toEqual(Array(99).fill(null));
    const latest = windows.at(-1)!;
    for (const [index, stale] of windows.slice(0, -1).entries()) {
      controllers[index].abort();
      stale.webContents.emit('did-finish-load');
      submit(stale, 'stale answer');
      expect(stale.show).not.toHaveBeenCalled();
    }
    expect(windows.filter((win) => !win.isDestroyed())).toEqual([latest]);
    latest.webContents.emit('did-finish-load');
    submit(latest, 'current answer');
    expect(await attempts.at(-1)).toBe('current answer');
    expect(windows.every((win) => win.isDestroyed())).toBe(true);
  });

  it('removes a closing host from the queue before it can create a window', async () => {
    const first = prompt('user@first');
    const second = prompt('user@second');
    const third = prompt('user@third');
    isHostOpen.mockImplementation((target) => target === 'user@third');
    prompter.cancel('user@second');
    expect(await second).toBeNull();
    expect(windows).toHaveLength(1);
    prompter.cancel('user@first');
    expect(await first).toBeNull();
    expect(windows).toHaveLength(2);
    expect(parent).toHaveBeenLastCalledWith('user@third');
    expect(await prompt('user@first')).toBeNull();
    expect(await prompt('user@second')).toBeNull();
    expect(windows).toHaveLength(2);
    submit(windows[1], 'third answer');
    expect(await third).toBe('third answer');
    // An explicit new connection may authenticate the host again.
    isHostOpen.mockReturnValue(true);
    const reopened = prompt('user@first');
    submit(windows[2], 'new answer');
    expect(await reopened).toBe('new answer');
  });

  it('removes disconnected requests both while visible and while queued', async () => {
    const active = new AbortController();
    const queued = new AbortController();
    const first = prompt('user@first', active);
    const second = prompt('user@second', queued);
    queued.abort();
    expect(await second).toBeNull();
    active.abort();
    expect(await first).toBeNull();
    expect(windows).toHaveLength(1);
    expect(windows[0].isDestroyed()).toBe(true);
    expect(await prompt('user@third', active)).toBeNull();
    expect(windows).toHaveLength(1);
  });

  it('advances to another host when the active request disappears', async () => {
    const active = new AbortController();
    const first = prompt('user@first', active);
    const second = prompt('user@second');
    active.abort();
    expect(await first).toBeNull();
    expect(windows).toHaveLength(2);
    ipcMain.emit('puddle:ssh-auth-cancel', { sender: windows[1].webContents });
    expect(await second).toBeNull();
  });

  it('cancels all work on shutdown without opening queued windows', async () => {
    const first = prompt('user@first');
    const second = prompt('user@second');
    prompter.close();
    expect(await Promise.all([first, second, prompt('user@third')])).toEqual([null, null, null]);
    expect(windows).toHaveLength(1);
    expect(windows[0].isDestroyed()).toBe(true);
    expect(ipcMain.listenerCount('puddle:ssh-auth-submit')).toBe(0);
  });
});
