import { loadHostIdentities, parseHostIdentity, saveHostIdentity } from './host-identities.js';
import { isShellTheme, loadShellTheme, saveShellTheme } from './appearance.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  PROTOCOL_VERSION,
  desktopWindowRouteSchema,
  type DesktopWindowIdentity,
} from '@puddle/shared';
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  screen,
  shell as osShell,
  type MenuItemConstructorOptions,
  type IpcMainInvokeEvent,
} from 'electron';
import {
  applyDesktopUpdate,
  checkForDesktopUpdate,
  clientHome,
  CliError,
  connectRemote,
  pruneDesktopUpdateCache,
  recordDesktopInstallation,
  stageDesktopUpdate,
  startLocal,
  type Logger,
  type RunningCockpit,
  type StagedDesktopUpdate,
} from '@puddle-code/cli/lib';
import { addRecentHost, loadRecentHosts, migrateRecentHosts } from './recent-hosts.js';
import { reopenWindowId, type ReopenWindow, type WindowPlacement } from './reopen.js';
import { createSshAuthPrompter } from './ssh-auth-prompt.js';
import { startSshAskpass, type RunningSshAskpass } from './ssh-askpass.js';
import { restoredCockpitBounds, type DisplayGeometry } from './window-bounds.js';
import { readX11Workspace, restoreX11Workspace } from './x11-workspace.js';
import { refreshNavigation } from './refresh-navigation.js';
import { hostUpdateApprovals } from './host-updates/approval.js';
import { DesktopNotifications } from './notifications.js';
import { HostConnections, type HostConnection } from './windows/connections.js';
import { DesktopWindowState } from './windows/state.js';
import { registerWindowStateIpc } from './windows/ipc.js';
import { WindowCommands } from './windows/commands.js';
import { WindowTransfers, registerWindowTransferIpc } from './windows/transfers.js';

/**
 * The desktop shell (SPEC §10): an Electron main process that drives the SAME
 * cockpit engine as the `puddle` bin — `startLocal`/`connectRemote` ensure the
 * daemon, serve the built web UI over localhost with /api + /ws + /proxy
 * attached, and this file merely points BrowserWindows at the results. One
 * connection per target serves its independently owned native windows.
 * Everything the cockpit does lives in `@puddle-code/cli/lib`;
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
const appearanceFile = () => join(clientHome(), 'desktop-appearance.json');
const hostIdentitiesFile = () => join(clientHome(), 'desktop-host-identities.json');
let promptTheme = loadShellTheme(appearanceFile());

const logger: Logger = {
  info: (message) => console.log(`[Puddle] ${message}`),
  warn: (message) => console.warn(`[Puddle] ${message}`),
};

interface ShellWindow {
  identity: DesktopWindowIdentity;
  win: BrowserWindow;
  trackingPlacement?: boolean;
}

type Shell = HostConnection<RunningCockpit, ShellWindow>;
const connections = new HostConnections<RunningCockpit, ShellWindow>(
  (target, previous, refreshId) =>
    openCockpit(target, previous ? Number(new URL(previous.origin).port) : undefined, refreshId),
);
const shells = connections.hosts;
const notifications = new Map<number, DesktopNotifications>();
// Include saved targets whose reconnect is still pending or failed. An empty
// live-shell map during startup must not erase the previous window set.
const rememberedWindows = new Map<string, ReopenWindow>();
let promptWin: BrowserWindow | null = null;
let pickerWin: BrowserWindow | null = null;
let stopped = false;
let quitting = false;
let quitPending = false;
let restoringWindows = true;
let windowStateLoaded = false;
let windowState: DesktopWindowState | null = null;
const windowCommands = new WindowCommands();
const checkpoints = new Map<string, Promise<void>>();
const windowTransfers = new WindowTransfers({
  state: () => {
    if (!windowState || quitting) throw new Error('Window state is unavailable');
    return windowState;
  },
  record: (id) => {
    if (quitting || quitPending) throw new Error('Application is closing');
    for (const host of shells.values()) {
      const window = host.windows.get(id);
      if (window && !window.win.isDestroyed()) return reopenWindow(host.target, window);
    }
    throw new Error('Source window is unavailable');
  },
  open: (record) => openShell(record.target, record.placement, record),
  dismiss: (id) => {
    rememberedWindows.delete(id);
    for (const host of shells.values()) {
      const window = host.windows.get(id);
      if (window && !window.win.isDestroyed()) window.win.destroy();
    }
    persistWindows();
  },
  report: (error) => logger.warn(errorText(error)),
  committed: () => {
    for (const record of windowState?.openWindows() ?? [])
      rememberedWindows.set(reopenWindowId(record), record);
  },
});

function checkpointWindow(id: string): Promise<void> {
  const pending = checkpoints.get(id);
  if (pending) return pending;
  if (!windowCommands.available(id)) return Promise.resolve();
  const operation = windowCommands.request(id, 'checkpoint').finally(() => {
    if (checkpoints.get(id) === operation) checkpoints.delete(id);
  });
  checkpoints.set(id, operation);
  return operation;
}

async function resumeWindows(ids: string[]): Promise<void> {
  await Promise.allSettled(
    ids
      .filter((id) => windowCommands.available(id))
      .map((id) =>
        windowCommands.request(id, 'resume').catch((error) => logger.warn(errorText(error))),
      ),
  );
}

function persistWindows(): void {
  windowState?.syncOpenWindows([...rememberedWindows.values()]);
}

const sshAuthPrompter = createSshAuthPrompter({
  htmlPath: join(here, 'ssh-auth-prompt.html'),
  theme: () => promptTheme,
  preloadPath: join(here, 'auth-preload.cjs'),
  isHostOpen: (target) => connections.has(target),
  // Focus may belong to another app or macOS Space during a reconnect; the
  // host still owns its prompt, which must remain attached to its cockpit.
  parent: (target) => preferredWindow(shells.get(target)) ?? promptWin ?? pickerWin,
});
let sshAskpassPromise: Promise<RunningSshAskpass> | null = null;

// Recents live in ~/.puddle (durable client state) so they survive app
// updates and reinstalls; older installs kept them in userData — migrate once.
const recentsFile = () => join(clientHome(), 'recent-hosts.json');
const legacyRecentsFile = () => join(app.getPath('userData'), 'recent-hosts.json');
const reopenFile = () => join(clientHome(), 'reopen-windows.json');

function packagedDesktopPath(): string {
  if (process.platform === 'darwin') return join(dirname(process.execPath), '..', '..');
  return process.env.APPIMAGE ?? process.execPath;
}

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

async function openCockpit(
  target: string,
  preferPort?: number,
  refreshId?: string,
): Promise<RunningCockpit> {
  const common = {
    assetsDir: join(here, 'public'),
    preferPort,
    refreshId,
    logger,
    ...hostUpdateApprovals({
      host: target,
      parent: () => preferredWindow(shells.get(target)) ?? promptWin ?? pickerWin ?? undefined,
      active: () => !stopped,
    }),
    // The UI's connection banner and ⌘K "Refresh connection" POST
    // /cockpit/refresh; in-process there is no process to swap, so refresh
    // is simply: close the UI server (and tunnel), re-run the same flow
    // (which restarts the daemon if it is down), keep the origin.
    onRefreshRequest: (id: string) => {
      const shell = shells.get(target);
      if (shell) void refreshShell(shell, id);
    },
  };
  if (target === LOCAL) return startLocal(common);
  const askpass = await sshAskpass();
  return connectRemote({ host: target, sshAskpassProgram: askpass.program, ...common });
}

async function refreshShell(shell: Shell, refreshId?: string): Promise<void> {
  try {
    await connections.refresh(shell, refreshId, (previous) => {
      for (const { win } of shell.windows.values()) {
        if (win.isDestroyed()) continue;
        const navigation = refreshNavigation(
          win.webContents.getURL(),
          previous.origin,
          shell.cockpit,
          refreshId,
        );
        if (navigation) void win.loadURL(navigation);
      }
    });
  } catch (e) {
    logger.warn(`refresh of ${shell.target} failed: ${errorText(e)}`);
  }
}

function preferredWindow(host: Shell | undefined): BrowserWindow | undefined {
  const windows = [...(host?.windows.values() ?? [])].filter(({ win }) => !win.isDestroyed());
  return (
    windows.find(({ win }) => win.isFocused?.()) ??
    windows.find(({ identity }) => identity.kind === 'host') ??
    windows[0]
  )?.win;
}

function hostForWindow(win: { id: number } | undefined | null): Shell | undefined {
  return [...shells.values()].find((host) =>
    [...host.windows.values()].some((window) => window.win === win),
  );
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

/** Primary-first display geometry: the first entry is the safe fallback. */
function displayGeometries(): DisplayGeometry[] {
  const primary = screen.getPrimaryDisplay();
  return [primary, ...screen.getAllDisplays().filter((display) => display.id !== primary.id)].map(
    (display) => ({ id: display.id, label: display.label, workArea: display.workArea }),
  );
}

function createWindow(
  target: string,
  cockpit: RunningCockpit,
  identity: DesktopWindowIdentity,
  placement?: WindowPlacement,
  route?: string,
): BrowserWindow {
  const initialBounds = restoredCockpitBounds(process.platform, displayGeometries(), placement);
  // An EWMH hint must exist before the X11 window is mapped. Create restored
  // workspace windows hidden for those few synchronous instructions, then map
  // them normally; every other path keeps Electron's ordinary immediate show.
  const workspace = process.platform === 'linux' ? placement?.workspace : undefined;
  const restoreWorkspace = workspace !== undefined;
  const win = new BrowserWindow({
    ...initialBounds,
    ...(restoreWorkspace ? { show: false } : {}),
    // On macOS the native title bar goes away entirely: the web app's own
    // top bar (host, ⌘K field, settings/scratchpad/profile) doubles as the
    // drag region, with the traffic lights inlaid — ShellLayout detects the
    // shell and insets 84px for them.
    //
    // Centre the native 14px buttons in the 36px header: (36 - 14) / 2 = 11.
    // Keep this aligned with ShellLayout's header height.
    ...(process.platform === 'darwin' && identity.kind === 'host'
      ? {
          titleBarStyle: 'hidden' as const,
          trafficLightPosition: { x: 12, y: 11 },
        }
      : {}),
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      // Chromium's PDF viewer, for the editor's PDF preview iframe — off by
      // default in Electron, and the pane renders blank without it.
      plugins: true,
    },
  });

  if (restoreWorkspace) {
    restoreX11Workspace(win.getMediaSourceId(), workspace);
    win.show();
  }

  const delivery = new DesktopNotifications(win, () => raise(win));
  const contentsId = win.webContents.id;
  notifications.set(contentsId, delivery);
  win.on('closed', () => {
    delivery.close();
    notifications.delete(contentsId);
    windowCommands.disconnected(identity.id);
    windowTransfers.disconnected(identity.id);
  });
  win.webContents.on('render-process-gone', () => {
    windowCommands.disconnected(identity.id);
    windowTransfers.disconnected(identity.id);
  });
  win.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace && windowCommands.available(identity.id)) {
      windowCommands.disconnected(identity.id);
      windowTransfers.disconnected(identity.id);
    }
  });

  let closeAccepted = false;
  let closePending = false;
  win.on('close', (event) => {
    if (quitting || closeAccepted) return;
    if (windowState?.staging(identity.id)) {
      event.preventDefault();
      windowTransfers.disconnected(identity.id);
      return;
    }
    if (quitPending) {
      event.preventDefault();
      return;
    }
    if (!windowCommands.available(identity.id)) return;
    event.preventDefault();
    if (closePending) return;
    closePending = true;
    void checkpointWindow(identity.id).then(
      () => {
        closePending = false;
        if (quitPending || quitting || win.isDestroyed()) return;
        closeAccepted = true;
        win.close();
      },
      async (error: unknown) => {
        closePending = false;
        // The app-wide attempt owns rollback and error presentation if it joined us.
        if (quitPending || quitting) return;
        await resumeWindows([identity.id]);
        if (!win.isDestroyed())
          dialog.showErrorBox('Could not close this window', errorText(error));
      },
    );
  });

  // Full-screen state is a WINDOW fact only the main process knows, and the top
  // bar needs it: with the native title bar hidden the bar insets 84px for the
  // inlaid traffic lights, which macOS HIDES in full-screen — leaving the host
  // name indented against nothing. Tell the renderer whenever it changes (it
  // also asks once on mount, below, for a window already full-screen).
  const sendFullScreen = () => {
    if (!win.isDestroyed()) win.webContents.send('puddle:fullscreen', win.isFullScreen());
  };
  win.on('enter-full-screen', sendFullScreen);
  win.on('leave-full-screen', sendFullScreen);
  // Native activation is authoritative across Mission Control / Spaces, where
  // Chromium's document focus can lag or omit the corresponding window event.
  win.on('focus', () => win.webContents.send('puddle:window-focus', true));
  win.on('blur', () => {
    if (!win.isDestroyed()) win.webContents.send('puddle:window-focus', false);
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
    if (new URL(url).origin === new URL(origin).origin) return;
    event.preventDefault();
    if (/^(vscode|cursor|https?):/.test(url)) void osShell.openExternal(url);
  });

  win.on('closed', () => {
    if (!quitting) {
      rememberedWindows.delete(identity.id);
      try {
        persistWindows();
      } catch (error) {
        logger.warn(`could not remember closed window: ${errorText(error)}`);
      }
    }
    void connections.close(target, identity.id).catch((error) => logger.warn(errorText(error)));
    if (!connections.has(target)) sshAuthPrompter.cancel(target);
  });

  const invitation = new URL(cockpit.createInvitation());
  invitation.pathname =
    route ?? (identity.kind === 'host' ? '/' : `/project/${identity.projectId}`);
  void win.loadURL(invitation.href);
  return win;
}

/** Open (or raise) the window for a target; errors surface with the caller. */
async function openShell(
  target: string,
  placement?: WindowPlacement,
  restored?: ReopenWindow,
): Promise<void> {
  if (quitting || quitPending) return;
  const identity = restored?.window ?? { kind: 'host' as const, id: reopenWindowId({ target }) };
  const existing = restored
    ? shells.get(target)?.windows.get(identity.id)
    : [...(shells.get(target)?.windows.values() ?? [])].find(
        ({ identity }) => identity.kind === 'host',
      );
  if (existing && !existing.win.isDestroyed()) {
    raise(existing.win);
    return;
  }
  try {
    const window = await connections.open(target, identity.id, (host) => ({
      identity,
      win: createWindow(target, host.cockpit, identity, placement, restored?.route),
    }));
    if (!window || quitting || quitPending) return;
    if (window.trackingPlacement) {
      raise(window.win);
      return;
    }
    window.trackingPlacement = true;
    rememberedWindows.set(identity.id, reopenWindow(target, window));
    persistWindows();
    // Save normal bounds and SPA destinations during use, not just orderly quit.
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const capture = () => {
      if (quitting || window.win.isDestroyed()) return;
      rememberedWindows.set(identity.id, reopenWindow(target, window));
      try {
        persistWindows();
      } catch (error) {
        logger.warn(`could not remember window: ${errorText(error)}`);
      }
    };
    const schedule = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(capture, 200);
    };
    window.win.on('move', schedule);
    window.win.on('resize', schedule);
    window.win.webContents.on('did-navigate-in-page', schedule);
    window.win.on('closed', () => clearTimeout(saveTimer));
  } finally {
    if (!connections.has(target)) sshAuthPrompter.cancel(target);
  }
}

/** Capture shell chrome while every quitting window still exists. */
function reopenWindow(target: string, window: ShellWindow): ReopenWindow {
  const record: ReopenWindow = { target, window: window.identity };
  if (window.win.isDestroyed()) return record;
  try {
    const currentUrl = window.win.webContents.getURL?.();
    const route = currentUrl
      ? desktopWindowRouteSchema.safeParse(new URL(currentUrl).pathname)
      : null;
    if (route?.success) record.route = route.data;
    const bounds = window.win.getNormalBounds();
    const display = screen.getDisplayMatching(bounds);
    const workspace =
      process.platform === 'linux' ? readX11Workspace(window.win.getMediaSourceId()) : null;
    return {
      ...record,
      placement: {
        bounds,
        displayId: display.id,
        displayLabel: display.label,
        displayWorkArea: display.workArea,
        ...(workspace !== null ? { workspace } : {}),
      },
    };
  } catch {
    // A window racing destruction still deserves target-only restoration.
    return record;
  }
}

// ---------------------------------------------------------------------------
// Connect-to-host prompt (File → Connect to SSH Host…)

function openConnectPrompt(): void {
  if (quitting) return;
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
  void promptWin.loadFile(join(here, 'connect-prompt.html'), { query: { theme: promptTheme } });
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
  if (quitting) return;
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
  void pickerWin.loadFile(join(here, 'host-picker.html'), { query: { theme: promptTheme } });
  pickerWin.on('closed', () => {
    pickerWin = null;
  });
}

function pickerStatus(state: 'connecting' | 'error', message?: string): void {
  pickerWin?.webContents.send('puddle:picker-status', { state, message });
}

async function openFromPicker(target: string): Promise<void> {
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

function pickerHosts() {
  const identities = loadHostIdentities(hostIdentitiesFile());
  return [LOCAL, ...loadRecentHosts(recentsFile())].map((target) => ({
    target,
    identity: identities.get(target) ?? null,
  }));
}
ipcMain.handle('puddle:picker-recents', (event) => {
  if (event.sender !== pickerWin?.webContents || event.senderFrame !== event.sender.mainFrame)
    return [];
  return pickerHosts();
});
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

// Only a cockpit's main frame can use its own notification channel.
function windowContext(event: IpcMainInvokeEvent) {
  if (event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid window sender');
  for (const host of shells.values()) {
    const window = [...host.windows.values()].find(
      ({ win }) => !win.isDestroyed() && win.webContents === event.sender,
    );
    if (!window) continue;
    if (new URL(event.senderFrame.url).origin !== new URL(host.cockpit.origin).origin) break;
    const staging = windowState?.staging(window.identity.id);
    return {
      identity: window.identity,
      hostId: reopenWindowId({ target: host.target }),
      ...(staging ? { stagingTransfer: staging.id } : {}),
    };
  }
  throw new Error('Window is unavailable');
}

registerWindowStateIpc({
  ipc: ipcMain,
  context: windowContext,
  state: () => {
    if (!windowState || quitting) throw new Error('Window state is unavailable');
    return windowState;
  },
});
registerWindowTransferIpc(ipcMain, windowContext, windowTransfers);

ipcMain.handle('puddle:window-ready', (event) => {
  const owner = windowContext(event);
  if (quitting || quitPending) throw new Error('Application is closing');
  windowCommands.ready(owner.identity.id, (command) =>
    event.sender.send('puddle:window-command', command),
  );
});
ipcMain.handle('puddle:window-reply', (event, reply: unknown) => {
  const owner = windowContext(event);
  windowCommands.reply(owner.identity.id, reply);
});

ipcMain.handle('puddle:notification-status', (event) => {
  if (event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid notification sender');
  const delivery = notifications.get(event.sender.id);
  if (!delivery) throw new Error('Notification window is unavailable');
  return delivery.status();
});
ipcMain.handle('puddle:notification-show', (event, request: unknown) => {
  if (event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid notification sender');
  const delivery = notifications.get(event.sender.id);
  if (!delivery) throw new Error('Notification window is unavailable');
  return delivery.show(request);
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
      for (const { win } of shell.windows.values()) {
        if (!win.isDestroyed()) win.webContents.send('puddle:update-ready', staged.version);
      }
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
            const shell = hostForWindow(win);
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
    {
      role: 'viewMenu',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        // Plain ⌘0 belongs to project switching in the renderer.
        { role: 'resetZoom', accelerator: 'CmdOrCtrl+Alt+0' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
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
    const first = preferredWindow(shells.get(LOCAL) ?? [...shells.values()][0]);
    if (first) raise(first);
    else if (!restoringWindows) openHostPicker();
  });

  void app.whenReady().then(() => {
    if (quitting) return;
    if (process.platform === 'darwin') {
      createRequire(import.meta.url)(join(here, 'command-key-up.node'));
    }
    // package.json's scoped npm name is an implementation detail; native menu
    // roles should say “About Puddle”, not “About @puddle-code/desktop”.
    app.setName('Puddle');
    app.setAboutPanelOptions({
      applicationVersion: app.getVersion(),
      version: `Protocol ${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}`,
    });
    if (app.isPackaged) {
      recordDesktopInstallation({
        path: packagedDesktopPath(),
        version: app.getVersion(),
        protocol: PROTOCOL_VERSION,
      });
    }
    migrateRecentHosts(legacyRecentsFile(), recentsFile());
    buildMenu();
    // Leftover staged downloads are dead weight at boot — an applied update's
    // helper removed its own dir, and any survivor (a stage the user never
    // restarted into, an older version) is re-downloaded fresh by the next
    // poll anyway, which stages into a clean dir.
    void pruneDesktopUpdateCache([]);
    void pollForUpdate();
    setInterval(() => void pollForUpdate(), UPDATE_POLL_MS);
    // Every launch reopens the remembered cockpit windows;
    // remote authentication can surface through the same askpass modal as a
    // manual connect. If nothing comes back the picker takes over as usual.
    try {
      windowState = new DesktopWindowState(reopenFile());
      windowState.recoverPending();
    } catch (error) {
      // Never replace unreadable working sets/drafts with an empty arrangement.
      dialog.showErrorBox('Could not restore desktop windows', errorText(error));
      app.quit();
      return;
    }
    const reopen = windowState.openWindows();
    for (const window of reopen) rememberedWindows.set(reopenWindowId(window), window);
    windowStateLoaded = true;
    if (reopen.length === 0) {
      restoringWindows = false;
      openHostPicker();
      return;
    }
    void Promise.allSettled(
      reopen.map((window) =>
        openShell(window.target, window.placement, window).catch((e) => {
          logger.warn(`could not reopen ${window.target}: ${errorText(e)}`);
          throw e;
        }),
      ),
    ).then(() => {
      restoringWindows = false;
      if (shells.size === 0) openHostPicker();
    });
  });

  // macOS dock re-activation with every window closed: back to the picker.
  app.on('activate', () => {
    if (!restoringWindows && BrowserWindow.getAllWindows().length === 0) openHostPicker();
  });

  // Closing the last window quits the shell on every platform (no tray, no
  // hidden resident process — daemons and their agents run on regardless,
  // exactly as when CLI cockpits are killed).
  app.on('window-all-closed', () => {
    // SSH authentication dialogues can close before the restored cockpit is
    // ready. The restore completion opens a picker if every connection fails.
    if (!restoringWindows) app.quit();
  });

  // Snapshot BEFORE Electron closes windows for a quit. An explicitly closed
  // window has already left `shells`, so it stays closed next time; windows
  // that are only disappearing because the app is quitting are restored.
  // The update path also reaches this event, replacing its former one-shot
  // special case with the same durable rule as every other restart.
  const finishQuit = () => {
    // A quit before ready must leave unread standing state intact.
    if (windowStateLoaded) {
      for (const shell of shells.values()) {
        for (const window of shell.windows.values()) {
          rememberedWindows.set(window.identity.id, reopenWindow(shell.target, window));
        }
      }
      persistWindows();
    }
    quitting = true;
    quitPending = false;
    void connections.dispose();
  };
  app.on('before-quit', (event) => {
    if (quitting) return;
    if (quitPending) {
      event.preventDefault();
      return;
    }
    const ids = [...shells.values()].flatMap((host) => [...host.windows.keys()]);
    if (!ids.some((id) => windowCommands.available(id))) {
      try {
        finishQuit();
      } catch (error) {
        event.preventDefault();
        dialog.showErrorBox('Could not save windows before quitting', errorText(error));
      }
      return;
    }
    event.preventDefault();
    quitPending = true;
    void (async () => {
      // Wait for every reply before rolling back; a sibling can still be saving.
      const results = await Promise.allSettled(ids.map(checkpointWindow));
      try {
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        finishQuit();
        app.quit();
      } catch (error) {
        await resumeWindows(ids);
        quitPending = false;
        dialog.showErrorBox('Could not save windows before quitting', errorText(error));
      }
    })();
  });

  // Belt and braces: window 'closed' handlers stop their own cockpits; this
  // catches a quit racing those stops (tunnels also die with the process).
  app.on('will-quit', (event) => {
    sshAuthPrompter.close();
    void sshAskpassPromise?.then(
      (askpass) => askpass.close(),
      () => undefined,
    );
    if (stopped) return;
    event.preventDefault();
    stopped = true;
    void connections.dispose().finally(() => app.exit(0));
  });
}

// Accept only a bounded preference from a registered cockpit's main frame.
ipcMain.on('puddle:appearance', (event, value: unknown) => {
  if (!isShellTheme(value) || event.senderFrame !== event.sender.mainFrame) return;
  const owner = [...shells.values()].find(({ windows }) =>
    [...windows.values()].some(({ win }) => !win.isDestroyed() && win.webContents === event.sender),
  );
  if (!owner || new URL(event.senderFrame.url).origin !== new URL(owner.cockpit.origin).origin)
    return;
  if (promptTheme === value) return;
  promptTheme = value;
  saveShellTheme(appearanceFile(), value);
});

// Cache presentation only from the registered cockpit's exact main-frame origin.
ipcMain.on('puddle:host-identity', (event, value: unknown) => {
  if (event.senderFrame !== event.sender.mainFrame) return;
  const identity = parseHostIdentity(value);
  if (!identity) return;
  const owner = [...shells.values()].find(({ windows }) =>
    [...windows.values()].some(({ win }) => !win.isDestroyed() && win.webContents === event.sender),
  );
  if (!owner || new URL(event.senderFrame.url).origin !== new URL(owner.cockpit.origin).origin)
    return;
  saveHostIdentity(hostIdentitiesFile(), owner.target, identity);
  pickerWin?.webContents.send('puddle:picker-hosts', pickerHosts());
});
