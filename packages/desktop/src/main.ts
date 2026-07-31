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
  applyDesktopUpdate,
  checkForDesktopUpdate,
  clientHome,
  CliError,
  connectRemote,
  stageDesktopUpdate,
  startLocal,
  type Logger,
  type RunningCockpit,
  type StagedDesktopUpdate,
} from '@puddle-code/cli/lib';
import { addRecentHost, loadRecentHosts, migrateRecentHosts } from './recent-hosts.js';

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
 * ControlMaster) connect fine; password/2FA hosts need `puddle launch` in a
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
let pickerWin: BrowserWindow | null = null;
let stopped = false;

// Recents live in ~/.puddle (durable client state) so they survive app
// updates and reinstalls; older installs kept them in userData — migrate once.
const recentsFile = () => join(clientHome(), 'recent-hosts.json');
const legacyRecentsFile = () => join(app.getPath('userData'), 'recent-hosts.json');

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
          '(ssh-copy-id) — for password/2FA hosts, use `puddle launch user@host` in a terminal.'
        : '';
    promptStatus('error', `${errorText(e)}${auth}`);
  }
}

ipcMain.on('puddle:connect-submit', (_event, host: unknown) => {
  if (typeof host === 'string') void connectFromPrompt(host);
});
ipcMain.on('puddle:connect-cancel', () => promptWin?.close());

// ---------------------------------------------------------------------------
// New-window host picker — the DEFAULT new-window behaviour: no window opens
// a cockpit until the user says where the work is. Local sits on top, recents
// follow, and "Other SSH host…" hands over to the connect prompt.

function openHostPicker(): void {
  if (pickerWin) {
    pickerWin.focus();
    return;
  }
  pickerWin = new BrowserWindow({
    width: 380,
    height: 400,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'New Puddle Window',
    webPreferences: { preload: join(here, 'picker-preload.cjs') },
  });
  pickerWin.setMenuBarVisibility(false);
  void pickerWin.loadFile(join(here, 'host-picker.html'));
  pickerWin.on('closed', () => {
    pickerWin = null;
  });
}

function pickerStatus(state: 'connecting' | 'error', message?: string): void {
  pickerWin?.webContents.send('puddle:picker-status', { state, message });
}

async function openFromPicker(target: string): Promise<void> {
  if (shells.has(target)) {
    pickerWin?.close();
    raise(shells.get(target)!.win);
    return;
  }
  pickerStatus('connecting', target === LOCAL ? 'Starting…' : `Connecting to ${target}…`);
  try {
    await openShell(target);
    if (target !== LOCAL) {
      addRecentHost(recentsFile(), target);
      buildMenu();
    }
    pickerWin?.close();
  } catch (e) {
    const auth =
      e instanceof CliError && e.code === 'ssh_unreachable'
        ? ' The app has no terminal for ssh prompts — for password/2FA hosts, use ' +
          '`puddle launch user@host` in a terminal.'
        : '';
    pickerStatus('error', `${errorText(e)}${auth}`);
  }
}

ipcMain.handle('puddle:picker-recents', () => loadRecentHosts(recentsFile()));
ipcMain.on('puddle:picker-choose', (_event, target: unknown) => {
  if (typeof target === 'string') void openFromPicker(target);
});
ipcMain.on('puddle:picker-other', () => {
  pickerWin?.close();
  openConnectPrompt();
});
ipcMain.on('puddle:picker-cancel', () => pickerWin?.close());

// A waiting-input notification's click must bring the app forward —
// window.focus() cannot raise an OS window from the renderer (see the web's
// use-waiting-notifications), so the preload bridges it here. Raises the
// WINDOW THAT ASKED, not a global one — each cockpit window is its own shell.
ipcMain.on('puddle:raise', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) raise(win);
});

// ---------------------------------------------------------------------------
// Self-update (SPEC §10): the CLI-style pipeline from lib/desktop-update —
// check GitHub releases, stage (download + SHA256SUMS verify + unpack) into
// ~/.puddle/cache/desktop, then swap on demand. No Squirrel, no signing
// requirement: a detached helper waits for this process to exit, replaces
// the install, and relaunches. The renderer only ever sees "an update is
// ready" and asks for the restart — everything else stays in this process.

const UPDATE_POLL_MS = 6 * 60 * 60 * 1000;
let stagedUpdate: StagedDesktopUpdate | null = null;

/** The path the swap replaces, or null when not running from a real install. */
function installTarget(): string | null {
  if (!app.isPackaged) return null;
  if (process.platform === 'darwin') {
    const bundle = app.getPath('exe').replace(/(\.app)\/Contents\/.*$/, '$1');
    return bundle.endsWith('.app') ? bundle : null;
  }
  return process.env.APPIMAGE ?? null; // set by the AppImage runtime
}

async function pollForUpdate(): Promise<void> {
  if (installTarget() === null) return;
  try {
    const update = await checkForDesktopUpdate(app.getVersion());
    if (update === null || stagedUpdate?.version === update.version) return;
    const staged = await stageDesktopUpdate(update, { logger });
    stagedUpdate = staged;
    logger.info(`update ${staged.version} staged — offering the restart banner`);
    for (const shell of shells.values()) {
      shell.win.webContents.send('puddle:update-ready', staged.version);
    }
  } catch (e) {
    logger.warn(`update check failed: ${errorText(e)}`); // offline is normal; retry next poll
  }
}

ipcMain.handle('puddle:update-ready', () => stagedUpdate?.version ?? null);
ipcMain.on('puddle:install-update', () => {
  const target = installTarget();
  if (stagedUpdate === null || target === null) return;
  void applyDesktopUpdate(stagedUpdate, {
    targetPath: target,
    waitPid: process.pid,
    relaunch: true,
    logger,
  }).then(() => app.quit());
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
        {
          // The same stop-and-reconnect the UI's connection banner and ⌘K
          // "Refresh connection" trigger via POST /cockpit/refresh — reachable
          // from the menu when the page itself is too wedged to serve it.
          // ⌘⇧R would collide with viewMenu's Force Reload, hence ⌥.
          label: 'Refresh Connection',
          accelerator: 'CmdOrCtrl+Alt+R',
          click: (_item, win) => {
            const shell = [...shells.values()].find((s) => s.win === win);
            if (shell) void refreshShell(shell);
          },
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    // editMenu is load-bearing on macOS: without it ⌘C/⌘V/⌘A do nothing.
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      // The windowMenu role keeps macOS's automatic open-window list; the
      // custom submenu puts New Window (the host picker) at the top.
      role: 'windowMenu',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: openHostPicker },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? [
              { type: 'separator' } satisfies MenuItemConstructorOptions,
              { role: 'front' } satisfies MenuItemConstructorOptions,
            ]
          : [{ role: 'close' } satisfies MenuItemConstructorOptions]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  // macOS dock right-click: the same New Window entry.
  if (process.platform === 'darwin') {
    app.dock?.setMenu(Menu.buildFromTemplate([{ label: 'New Window', click: openHostPicker }]));
  }
}

// ---------------------------------------------------------------------------
// App lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const first = shells.get(LOCAL) ?? [...shells.values()][0];
    if (first) raise(first.win);
    else openHostPicker();
  });

  void app.whenReady().then(() => {
    migrateRecentHosts(legacyRecentsFile(), recentsFile());
    buildMenu();
    void pollForUpdate();
    setInterval(() => void pollForUpdate(), UPDATE_POLL_MS);
    // No default target: every new window starts at the host picker — the
    // user says where the work is (local on top, then recents).
    openHostPicker();
  });

  // macOS dock re-activation with every window closed: back to the picker.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openHostPicker();
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
