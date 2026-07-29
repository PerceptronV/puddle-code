import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  shell as osShell,
  type MenuItemConstructorOptions,
} from 'electron';
import {
  CliError,
  connectRemote,
  startLocal,
  type Logger,
  type RunningCockpit,
} from '@puddle-code/cli/lib';
import { addRecentHost, loadRecentHosts } from './recent-hosts.js';

/**
 * The desktop shell (SPEC §10): an Electron main process that drives the SAME
 * cockpit engine as the `puddle` bin — `startLocal`/`connectRemote` ensure the
 * daemon, serve the built web UI over localhost with /api + /ws + /proxy
 * attached, and this file merely points BrowserWindows at the results. One
 * window per target ('local' or user@host), mirroring the CLI's
 * one-cockpit-per-target model and the web app's one-daemon-per-origin
 * assumption. Everything the cockpit does lives in `@puddle-code/cli/lib`;
 * anything added here should be shell concerns only (windows, menus, OS
 * integration), or it belongs on the other side of the seam where both
 * shells inherit it.
 *
 * Daemons are supervised on their hosts (launchd/systemd via install.sh),
 * exactly as with the CLI: closing a window stops that cockpit's UI server
 * and tunnel only — never the daemon or its agents.
 *
 * Remote-host caveat, same as detached CLI cockpits (SPEC §10): there is no
 * TTY here, so ssh cannot prompt — key-authenticated hosts (or a warm
 * ControlMaster) connect fine; password/2FA hosts need `puddle connect` in a
 * terminal.
 */

const here = dirname(fileURLToPath(import.meta.url));
const LOCAL = 'local';

const logger: Logger = {
  info: (message) => console.log(`[puddle] ${message}`),
  warn: (message) => console.warn(`[puddle] ${message}`),
};

interface Shell {
  target: string; // 'local' or the ssh destination (user@host / ssh alias)
  cockpit: RunningCockpit;
  win: BrowserWindow;
  refreshing: boolean;
}

const shells = new Map<string, Shell>();
const connecting = new Set<string>();
let promptWin: BrowserWindow | null = null;
let stopped = false;

const recentsFile = () => join(app.getPath('userData'), 'recent-hosts.json');

function openCockpit(target: string, preferPort?: number): Promise<RunningCockpit> {
  const common = {
    assetsDir: join(here, 'public'),
    preferPort,
    logger,
    // The UI's connection banner and ⌘K "Refresh connection" POST
    // /cockpit/refresh; in-process there is no process to swap, so refresh
    // is simply: close the UI server (and tunnel), re-run the same flow
    // (which restarts the daemon if it is down), keep the origin.
    onRefreshRequest: () => {
      const shell = shells.get(target);
      if (shell) void refreshShell(shell);
    },
  };
  return target === LOCAL ? startLocal(common) : connectRemote({ host: target, ...common });
}

async function refreshShell(shell: Shell): Promise<void> {
  if (shell.refreshing) return;
  shell.refreshing = true;
  try {
    const oldOrigin = shell.cockpit.origin;
    const preferPort = Number(new URL(oldOrigin).port);
    await shell.cockpit.stop();
    shell.cockpit = await openCockpit(shell.target, preferPort);
    // The page polls its old origin and reloads itself once /api/version
    // answers; only a stolen port (new origin) needs an explicit repoint.
    if (shell.cockpit.origin !== oldOrigin && !shell.win.isDestroyed())
      void shell.win.loadURL(shell.cockpit.browserUrl);
  } catch (e) {
    logger.warn(`refresh of ${shell.target} failed: ${errorText(e)}`);
  } finally {
    shell.refreshing = false;
  }
}

function errorText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const hint = e instanceof CliError && e.hint !== undefined ? ` — ${e.hint}` : '';
  return `${message}${hint}`;
}

function raise(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  app.focus({ steal: true });
}

function createWindow(target: string, cockpit: RunningCockpit): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    // On macOS the native title bar goes away entirely: the web app's own
    // top bar (host, ⌘K field, settings/scratchpad/profile) doubles as the
    // drag region, with the traffic lights inlaid — ShellLayout detects the
    // shell, insets for them, and grows the bar to 40px so nothing squashes.
    // y centres the 12px buttons in that 40px bar.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 14 } }
      : {}),
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void osShell.openExternal(url);
    return { action: 'deny' };
  });

  // Editor deep links (vscode://, cursor://) navigate via window.location in
  // the web app — in a browser the OS takes over and the tab stays put, but
  // Electron would try (and silently fail) to navigate the renderer. Hand
  // anything that leaves this cockpit's origin to the OS instead. The origin
  // is read through the shells map so a refresh that moved ports stays right.
  win.webContents.on('will-navigate', (event, url) => {
    const origin = shells.get(target)?.cockpit.origin ?? cockpit.origin;
    if (url.startsWith(origin)) return;
    event.preventDefault();
    if (/^(vscode|cursor|https?):/.test(url)) void osShell.openExternal(url);
  });

  win.on('closed', () => {
    const shell = shells.get(target);
    shells.delete(target);
    // Stops this cockpit's UI server (and tunnel, remotely) only — the
    // daemon and its agents run on.
    if (shell) void shell.cockpit.stop();
  });

  void win.loadURL(cockpit.browserUrl);
  return win;
}

/** Open (or raise) the window for a target; errors surface with the caller. */
async function openShell(target: string): Promise<void> {
  const existing = shells.get(target);
  if (existing) {
    raise(existing.win);
    return;
  }
  if (connecting.has(target)) return;
  connecting.add(target);
  try {
    const cockpit = await openCockpit(target);
    const win = createWindow(target, cockpit);
    shells.set(target, { target, cockpit, win, refreshing: false });
  } finally {
    connecting.delete(target);
  }
}

// ---------------------------------------------------------------------------
// Connect-to-host prompt (File → Connect to SSH Host…)

function openConnectPrompt(): void {
  if (promptWin) {
    promptWin.focus();
    return;
  }
  promptWin = new BrowserWindow({
    width: 460,
    height: 190,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Connect to SSH Host',
    webPreferences: { preload: join(here, 'prompt-preload.cjs') },
  });
  promptWin.setMenuBarVisibility(false); // Windows/Linux: no menu on the dialogue
  void promptWin.loadFile(join(here, 'connect-prompt.html'));
  promptWin.on('closed', () => {
    promptWin = null;
  });
}

function promptStatus(state: 'connecting' | 'error', message?: string): void {
  promptWin?.webContents.send('puddle:connect-status', { state, message });
}

async function connectFromPrompt(rawHost: string): Promise<void> {
  const host = rawHost.trim();
  if (host === '' || host === LOCAL) return;
  if (shells.has(host)) {
    promptWin?.close();
    raise(shells.get(host)!.win);
    return;
  }
  promptStatus('connecting');
  try {
    await openShell(host);
    addRecentHost(recentsFile(), host);
    buildMenu();
    promptWin?.close();
  } catch (e) {
    const auth =
      e instanceof CliError && e.code === 'ssh_unreachable'
        ? ' The app has no terminal for ssh prompts, so the host must accept key authentication ' +
          '(ssh-copy-id) — for password/2FA hosts, use `puddle connect` in a terminal.'
        : '';
    promptStatus('error', `${errorText(e)}${auth}`);
  }
}

ipcMain.on('puddle:connect-submit', (_event, host: unknown) => {
  if (typeof host === 'string') void connectFromPrompt(host);
});
ipcMain.on('puddle:connect-cancel', () => promptWin?.close());

// A waiting-input notification's click must bring the app forward —
// window.focus() cannot raise an OS window from the renderer (see the web's
// use-waiting-notifications), so the preload bridges it here. Raises the
// WINDOW THAT ASKED, not a global one — each cockpit window is its own shell.
ipcMain.on('puddle:raise', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) raise(win);
});

// ---------------------------------------------------------------------------
// Application menu

function buildMenu(): void {
  const recents = loadRecentHosts(recentsFile());
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{ role: 'appMenu' } satisfies MenuItemConstructorOptions]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Connect to SSH Host…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: openConnectPrompt,
        },
        {
          label: 'Recent Hosts',
          enabled: recents.length > 0,
          submenu: recents.map((host) => ({
            label: host,
            click: () => {
              void openShell(host).catch((e) =>
                dialog.showErrorBox(`Could not connect to ${host}`, errorText(e)),
              );
            },
          })),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    // editMenu is load-bearing on macOS: without it ⌘C/⌘V/⌘A do nothing.
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// App lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const first = shells.get(LOCAL) ?? [...shells.values()][0];
    if (first) raise(first.win);
  });

  void app.whenReady().then(async () => {
    buildMenu();
    try {
      await openShell(LOCAL);
    } catch (e) {
      dialog.showErrorBox('puddle could not start', errorText(e));
      app.quit();
    }
  });

  // macOS dock re-activation with every window closed: reopen local.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void openShell(LOCAL).catch((e) =>
        dialog.showErrorBox('puddle could not start', errorText(e)),
      );
    }
  });

  // Closing the last window quits the shell on every platform (no tray, no
  // hidden resident process — daemons and their agents run on regardless,
  // exactly as when CLI cockpits are killed).
  app.on('window-all-closed', () => app.quit());

  // Belt and braces: window 'closed' handlers stop their own cockpits; this
  // catches a quit racing those stops (tunnels also die with the process).
  app.on('will-quit', (event) => {
    if (stopped || shells.size === 0) return;
    event.preventDefault();
    stopped = true;
    const all = [...shells.values()];
    shells.clear();
    void Promise.allSettled(all.map((s) => s.cockpit.stop())).finally(() => app.exit(0));
  });
}
