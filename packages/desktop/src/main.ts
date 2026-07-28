import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { CliError, startLocal, type Logger, type RunningCockpit } from '@puddle-code/cli/lib';

/**
 * The desktop shell (SPEC §10): an Electron main process that drives the SAME
 * cockpit engine as the `puddle` bin — `startLocal` ensures the daemon,
 * serves the built web UI over localhost with /api + /ws + /proxy attached,
 * and this file merely points a BrowserWindow at it. Everything the cockpit
 * does (bootstrap, handshake, proxying, refresh, local-sync) lives in
 * `@puddle-code/cli/lib`; anything added here should be shell concerns only
 * (windows, menus, OS integration), or it belongs on the other side of the
 * seam where both shells inherit it.
 *
 * The daemon is supervised OUTSIDE the app (launchd/systemd via install.sh),
 * exactly as with the CLI: quitting the desktop app never touches running
 * agents.
 */

const here = dirname(fileURLToPath(import.meta.url));

const logger: Logger = {
  info: (message) => console.log(`[puddle] ${message}`),
  warn: (message) => console.warn(`[puddle] ${message}`),
};

let cockpit: RunningCockpit | null = null;
let win: BrowserWindow | null = null;
let refreshing = false;
let stopped = false;

function openCockpit(preferPort?: number): Promise<RunningCockpit> {
  return startLocal({
    assetsDir: join(here, 'public'),
    preferPort,
    logger,
    // The UI's connection banner and ⌘K "Refresh connection" POST
    // /cockpit/refresh; in-process there is no process to swap, so refresh
    // is simply: close the UI server, re-run the same start flow (which
    // restarts the daemon if it is down), keep the origin.
    onRefreshRequest: () => void refresh(),
  });
}

async function refresh(): Promise<void> {
  if (refreshing || !cockpit) return;
  refreshing = true;
  try {
    const oldOrigin = cockpit.origin;
    const preferPort = Number(new URL(oldOrigin).port);
    await cockpit.stop();
    cockpit = await openCockpit(preferPort);
    // The page polls its old origin and reloads itself once /api/version
    // answers; only a stolen port (new origin) needs an explicit repoint.
    if (cockpit.origin !== oldOrigin) win?.loadURL(cockpit.browserUrl);
  } catch (e) {
    logger.warn(`refresh failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    refreshing = false;
  }
}

function raiseWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  app.focus({ steal: true });
}

function createWindow(url: string): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      // Chromium's PDF viewer, for the editor's PDF preview iframe — off by
      // default in Electron, and the pane renders blank without it.
      plugins: true,
    },
  });

  // Links that leave the cockpit (terminal web links, the ports strip,
  // markdown previews) open in the system browser — never a chromeless
  // child window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });

  // Editor deep links (vscode://, cursor://) navigate via window.location in
  // the web app — in a browser the OS takes over and the tab stays put, but
  // Electron would try (and silently fail) to navigate the renderer. Hand
  // anything that leaves the cockpit's origin to the OS instead.
  win.webContents.on('will-navigate', (event, target) => {
    if (cockpit && target.startsWith(cockpit.origin)) return;
    event.preventDefault();
    if (/^(vscode|cursor|https?):/.test(target)) void shell.openExternal(target);
  });

  win.on('closed', () => {
    win = null;
  });
  void win.loadURL(url);
}

// A waiting-input notification's click must bring the app forward —
// window.focus() cannot raise an OS window from the renderer (see the web's
// use-waiting-notifications), so the preload bridges it here.
ipcMain.on('puddle:raise', raiseWindow);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', raiseWindow);

  void app.whenReady().then(async () => {
    try {
      cockpit = await openCockpit();
      createWindow(cockpit.browserUrl);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const hint = e instanceof CliError && e.hint !== undefined ? `\n\n${e.hint}` : '';
      dialog.showErrorBox('puddle could not start', `${message}${hint}`);
      app.quit();
    }
  });

  // macOS dock re-activation after the window was closed.
  app.on('activate', () => {
    if (!win && cockpit) createWindow(cockpit.browserUrl);
  });

  // Closing the window quits the shell on every platform (no tray, no hidden
  // resident process — the daemon and its agents run on regardless, exactly
  // as when a `puddle start` cockpit is killed).
  app.on('window-all-closed', () => app.quit());

  app.on('will-quit', (event) => {
    if (stopped || !cockpit) return;
    event.preventDefault();
    stopped = true;
    void cockpit.stop().finally(() => app.exit(0));
  });
}
