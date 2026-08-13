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
  pruneDesktopUpdateCache,
  stageDesktopUpdate,
  startLocal,
  type Logger,
  type RunningCockpit,
  type StagedDesktopUpdate,
} from '@puddle-code/cli/lib';
import { addRecentHost, loadRecentHosts, migrateRecentHosts } from './recent-hosts.js';
import { consumeReopenTargets, saveReopenTargets } from './reopen.js';
import { createSshAuthPrompter } from './ssh-auth-prompt.js';
import { startSshAskpass, type RunningSshAskpass } from './ssh-askpass.js';

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
 * Remote authentication stays with the system ssh binary. Because this shell
 * has no TTY, its standard SSH_ASKPASS bridge presents password, key
 * passphrase, host-confirmation, and keyboard-interactive/2FA requests in a
 * dedicated modal; answers are relayed in memory and never stored.
 */

const here = dirname(fileURLToPath(import.meta.url));
const LOCAL = 'local';

const logger: Logger = {
  info: (message) => console.log(`[Puddle] ${message}`),
  warn: (message) => console.warn(`[Puddle] ${message}`),
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

const sshAuthPrompter = createSshAuthPrompter({
  htmlPath: join(here, 'ssh-auth-prompt.html'),
  preloadPath: join(here, 'auth-preload.cjs'),
  parent: () => promptWin ?? pickerWin ?? BrowserWindow.getFocusedWindow(),
});
let sshAskpassPromise: Promise<RunningSshAskpass> | null = null;

// Recents live in ~/.puddle (durable client state) so they survive app
// updates and reinstalls; older installs kept them in userData — migrate once.
const recentsFile = () => join(clientHome(), 'recent-hosts.json');
const legacyRecentsFile = () => join(app.getPath('userData'), 'recent-hosts.json');
const reopenFile = () => join(clientHome(), 'reopen-windows.json');

function sshAskpass(): Promise<RunningSshAskpass> {
  if (sshAskpassPromise === null) {
    const starting = startSshAskpass({
      home: clientHome(),
      electronPath: process.execPath,
      // ELECTRON_RUN_AS_NODE cannot be trusted to resolve a script inside an
      // asar archive, so the one executable helper is unpacked at packaging.
      helperPath: app.isPackaged
        ? join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'askpass-helper.cjs')
        : join(here, 'askpass-helper.cjs'),
      prompt: sshAuthPrompter.prompt,
    });
    sshAskpassPromise = starting;
    void starting.catch(() => {
      if (sshAskpassPromise === starting) sshAskpassPromise = null;
    });
  }
  return sshAskpassPromise;
}

async function openCockpit(target: string, preferPort?: number): Promise<RunningCockpit> {
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
  if (target === LOCAL) return startLocal(common);
  const askpass = await sshAskpass();
  return connectRemote({ host: target, sshAskpassProgram: askpass.program, ...common });
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
    // shell and insets 88px for them.
    //
    // y centres the 12px buttons in that bar, which is 36px tall in every
    // window state (`ShellLayout.TopBar`): (36 - 12) / 2 = 12. The host name is
    // centred in the same box, so the lights line up with it by construction —
    // measured against a screenshot of the 40px bar this replaces, where y:14
    // put the light centres within a pixel of the name's. The two numbers are
    // one decision: change the bar height and this moves with it.
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hidden' as const,
          trafficLightPosition: { x: 12, y: 12 },
          // The 1440×900 launch size reaches the work-area bounds on common
          // Mac displays. A native rounded mask plus shadow leaves a visible
          // sliver of desktop down the right and bottom edges even though the
          // window itself is correctly sized. The cockpit owns all its chrome,
          // so keep those edges flush; small shell dialogues remain native.
          roundedCorners: false,
          hasShadow: false,
        }
      : {}),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      // Chromium's PDF viewer, for the editor's PDF preview iframe — off by
      // default in Electron, and the pane renders blank without it.
      plugins: true,
    },
  });

  // Full-screen state is a WINDOW fact only the main process knows, and the top
  // bar needs it: with the native title bar hidden the bar insets 88px for the
  // inlaid traffic lights, which macOS HIDES in full-screen — leaving the host
  // name indented against nothing. Tell the renderer whenever it changes (it
  // also asks once on mount, below, for a window already full-screen).
  const sendFullScreen = () => {
    if (!win.isDestroyed()) win.webContents.send('puddle:fullscreen', win.isFullScreen());
  };
  win.on('enter-full-screen', sendFullScreen);
  win.on('leave-full-screen', sendFullScreen);

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
    promptStatus('error', errorText(e));
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
    pickerStatus('error', errorText(e));
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

// The `window.close` hotkey (⌘⇧W by default). A renderer cannot close a window
// it did not open, so the key travels here — and it comes through the renderer
// rather than a menu accelerator precisely so a rebind in Settings → Hotkeys is
// honoured (the File → Close item below keeps the glyph but registers nothing).
ipcMain.on('puddle:close-window', (event) => BrowserWindow.fromWebContents(event.sender)?.close());

// The renderer's first read of its own window's full-screen state (the events in
// createWindow carry every later change). A reload while full-screen fires no
// enter/leave event, so without this the top bar would come back inset for
// traffic lights that are not there.
ipcMain.handle(
  'puddle:is-fullscreen',
  (event) => BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false,
);

// ---------------------------------------------------------------------------
// Self-update (SPEC §10): the CLI-style pipeline from lib/desktop-update —
// check GitHub releases, stage (download + SHA256SUMS verify + unpack) into
// ~/.puddle/cache/desktop, then swap on demand. No Squirrel, no signing
// requirement: a detached helper waits for this process to exit, replaces
// the install, and relaunches. The renderer only ever sees "an update is
// ready" and asks for the restart — everything else stays in this process.

// Half-hourly (6h through v0.0.34): the check is one cheap GitHub API call,
// and a staged release should reach a long-running app the same morning it
// ships, not most of a working day later.
const UPDATE_POLL_MS = 30 * 60 * 1000;
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
    // `releases/latest` means an app several versions behind stages ONLY the
    // newest release — intermediate versions are never downloaded or applied.
    const update = await checkForDesktopUpdate(app.getVersion());
    if (update === null || stagedUpdate?.version === update.version) return;
    const staged = await stageDesktopUpdate(update, { logger });
    stagedUpdate = staged;
    // A release that was staged but never applied before a newer one arrived
    // is now unreachable — only the latest stage is ever offered or installed.
    await pruneDesktopUpdateCache([staged.version]);
    logger.info(`update ${staged.version} staged — offering the restart toast`);
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
  // The relaunch should land where the user was, not on the host picker:
  // remember every open window's target for the next launch to reopen.
  saveReopenTargets(reopenFile(), [...shells.keys()]);
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
        // ⌘⇧W (the browser close-window convention): plain ⌘W must reach the
        // renderer, where it is the desktop default for closing a tab. The
        // accelerator is DISPLAYED but not registered — the renderer's hotkey
        // registry owns the key (`window.close`), so rebinding it in Settings →
        // Hotkeys actually moves the shortcut. Clicking the item still closes.
        { role: 'close', accelerator: 'CmdOrCtrl+Shift+W', registerAccelerator: false },
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
        // ⇧⌘N, not ⌘N: plain ⌘N must reach the renderer, where it is the
        // desktop default for a new untitled file (`tab.newUntitled`) — a menu
        // accelerator would swallow it before the hotkey dispatcher ever saw it.
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: openHostPicker },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? [
              { type: 'separator' } satisfies MenuItemConstructorOptions,
              { role: 'front' } satisfies MenuItemConstructorOptions,
            ]
          : [
              // Same yield as the File menu's close: Ctrl+W belongs to the tab,
              // and the renderer owns Ctrl+Shift+W so a rebind is honoured.
              {
                role: 'close',
                accelerator: 'CmdOrCtrl+Shift+W',
                registerAccelerator: false,
              } satisfies MenuItemConstructorOptions,
            ]),
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
    // Leftover staged downloads are dead weight at boot — an applied update's
    // helper removed its own dir, and any survivor (a stage the user never
    // restarted into, an older version) is re-downloaded fresh by the next
    // poll anyway, which stages into a clean dir.
    void pruneDesktopUpdateCache([]);
    void pollForUpdate();
    setInterval(() => void pollForUpdate(), UPDATE_POLL_MS);
    // An update relaunch reopens the windows the restart closed (one-shot,
    // recorded as the swap began); remote authentication can surface through
    // the same askpass modal as a manual connect. If nothing comes back the
    // picker takes over as usual. Every other launch has no default target:
    // the host picker asks where the work is.
    const reopen = consumeReopenTargets(reopenFile());
    if (reopen.length === 0) {
      openHostPicker();
      return;
    }
    void Promise.allSettled(
      reopen.map((target) =>
        openShell(target).catch((e) => {
          logger.warn(`could not reopen ${target} after the update: ${errorText(e)}`);
          throw e;
        }),
      ),
    ).then(() => {
      if (shells.size === 0) openHostPicker();
    });
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
    sshAuthPrompter.close();
    void sshAskpassPromise?.then(
      (askpass) => askpass.close(),
      () => undefined,
    );
    if (stopped || shells.size === 0) return;
    event.preventDefault();
    stopped = true;
    const all = [...shells.values()];
    shells.clear();
    void Promise.allSettled(all.map((s) => s.cockpit.stop())).finally(() => app.exit(0));
  });
}
