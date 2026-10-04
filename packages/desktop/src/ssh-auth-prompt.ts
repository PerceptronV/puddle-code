import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import type { SshAskpassRequest } from './ssh-askpass.js';

interface PendingPrompt {
  request: SshAskpassRequest;
  win: BrowserWindow | null;
  finish(answer: string | null, advance?: boolean): void;
}

/** A serial, modal UI for OpenSSH askpass requests from any connecting host. */
export function createSshAuthPrompter(opts: {
  htmlPath: string;
  preloadPath: string;
  parent(): BrowserWindow | null;
}): {
  prompt(request: SshAskpassRequest, signal: AbortSignal): Promise<string | null>;
  close(): void;
} {
  let pending: PendingPrompt | null = null;
  let closed = false;
  const queue: PendingPrompt[] = [];

  const fromPendingWindow = (sender: WebContents): boolean =>
    pending !== null && pending.win?.webContents === sender;

  const onSubmit = (event: Electron.IpcMainEvent, answer: unknown) => {
    if (!fromPendingWindow(event.sender) || typeof answer !== 'string') return;
    pending?.finish(answer);
  };
  const onCancel = (event: Electron.IpcMainEvent) => {
    if (fromPendingWindow(event.sender)) pending?.finish(null);
  };
  ipcMain.on('puddle:ssh-auth-submit', onSubmit);
  ipcMain.on('puddle:ssh-auth-cancel', onCancel);

  const showNext = () => {
    if (closed || pending !== null) return;
    const current = queue.shift();
    if (!current) return;
    pending = current;
    const candidate = opts.parent();
    const parent = candidate !== null && !candidate.isDestroyed() ? candidate : undefined;
    try {
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
      current.win = win;
      win.setMenuBarVisibility(false);
      win.webContents.once('did-finish-load', () => {
        if (pending === current && !win.isDestroyed()) {
          win.webContents.send('puddle:ssh-auth-request', current.request);
          win.show();
          win.focus();
        }
      });
      win.on('closed', () => current.finish(null));
      void win.loadFile(opts.htmlPath).catch(() => current.finish(null));
    } catch {
      current.finish(null);
    }
  };

  return {
    prompt(request, signal) {
      if (closed || signal.aborted) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        let settled = false;
        const cancel = () => current.finish(null);
        const current: PendingPrompt = {
          request,
          win: null,
          finish(answer, advance = true) {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', cancel);
            const index = queue.indexOf(current);
            if (index !== -1) queue.splice(index, 1);
            if (pending === current) pending = null;
            // Destroy synchronously: a stale renderer must disappear before
            // its replacement opens, even if it has not finished loading.
            if (current.win && !current.win.isDestroyed()) current.win.destroy();
            resolve(answer);
            if (advance) showNext();
          },
        };
        // Keep distinct hosts serial, but never retain a backlog for one host.
        const previous = [...(pending ? [pending] : []), ...queue];
        for (const old of previous) {
          if (old.request.target === request.target) old.finish(null, false);
        }
        queue.push(current);
        signal.addEventListener('abort', cancel, { once: true });
        showNext();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      pending?.finish(null);
      for (const current of [...queue]) current.finish(null);
      ipcMain.removeListener('puddle:ssh-auth-submit', onSubmit);
      ipcMain.removeListener('puddle:ssh-auth-cancel', onCancel);
    },
  };
}
