import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import type { SshAskpassRequest } from './ssh-askpass.js';

interface PendingPrompt {
  win: BrowserWindow;
  resolve(answer: string | null): void;
}

/** A serial, modal UI for OpenSSH askpass requests from any connecting host. */
export function createSshAuthPrompter(opts: {
  htmlPath: string;
  preloadPath: string;
  parent(): BrowserWindow | null;
}): {
  prompt(request: SshAskpassRequest): Promise<string | null>;
  close(): void;
} {
  let pending: PendingPrompt | null = null;
  let closed = false;
  let queue: Promise<void> = Promise.resolve();

  const fromPendingWindow = (sender: WebContents): boolean =>
    pending !== null && pending.win.webContents === sender;

  const settle = (answer: string | null) => {
    const current = pending;
    if (current === null) return;
    pending = null;
    current.resolve(answer);
    if (!current.win.isDestroyed()) current.win.close();
  };

  const onSubmit = (event: Electron.IpcMainEvent, answer: unknown) => {
    if (!fromPendingWindow(event.sender) || typeof answer !== 'string') return;
    settle(answer);
  };
  const onCancel = (event: Electron.IpcMainEvent) => {
    if (fromPendingWindow(event.sender)) settle(null);
  };
  ipcMain.on('puddle:ssh-auth-submit', onSubmit);
  ipcMain.on('puddle:ssh-auth-cancel', onCancel);

  const show = (request: SshAskpassRequest): Promise<string | null> => {
    if (closed) return Promise.resolve(null);
    const candidate = opts.parent();
    const parent = candidate !== null && !candidate.isDestroyed() ? candidate : undefined;
    return new Promise<string | null>((resolve) => {
      const win = new BrowserWindow({
        width: 460,
        height: 210,
        show: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        title: 'SSH Authentication',
        ...(parent === undefined ? {} : { parent, modal: true }),
        webPreferences: { preload: opts.preloadPath },
      });
      pending = { win, resolve };
      win.setMenuBarVisibility(false);
      win.webContents.once('did-finish-load', () => {
        if (!win.isDestroyed()) {
          win.webContents.send('puddle:ssh-auth-request', request);
          win.show();
          win.focus();
        }
      });
      win.on('closed', () => {
        if (pending?.win === win) {
          pending = null;
          resolve(null);
        }
      });
      void win.loadFile(opts.htmlPath);
    });
  };

  return {
    prompt(request) {
      const answer = queue.then(() => show(request));
      queue = answer.then(
        () => undefined,
        () => undefined,
      );
      return answer;
    },
    close() {
      if (closed) return;
      closed = true;
      settle(null);
      ipcMain.removeListener('puddle:ssh-auth-submit', onSubmit);
      ipcMain.removeListener('puddle:ssh-auth-cancel', onCancel);
    },
  };
}
