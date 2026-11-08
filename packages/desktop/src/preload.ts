import { contextBridge, ipcRenderer } from 'electron';

/**
 * The one bridge the web app gets from the desktop shell. Its presence is
 * also the web's "running under the desktop app" signal (notification
 * permission handling differs there — see use-waiting-notifications).
 * Built as CJS (preload scripts run sandboxed). Every member must be a
 * capability the renderer genuinely cannot provide for itself — raising the
 * OS window, and driving the shell's self-update (lib/desktop-update runs in
 * the main process; the renderer only learns a version is ready and asks for
 * the restart).
 */
contextBridge.exposeInMainWorld('puddleDesktop', {
  windows: {
    version: 1,
    context: () => ipcRenderer.invoke('puddle:window-context'),
    reload: () => ipcRenderer.invoke('puddle:window-reload'),
    read: (profileId: string) => ipcRenderer.invoke('puddle:window-read', { profileId }),
    write: (request: unknown) => ipcRenderer.invoke('puddle:window-write', request),
    transfers: {
      preparePane: (request: unknown) => ipcRenderer.invoke('puddle:window-prepare-pane', request),
      commit: (request: unknown) => ipcRenderer.invoke('puddle:window-transfer-commit', request),
      cancel: (request: unknown) => ipcRenderer.invoke('puddle:window-transfer-cancel', request),
      observe: (request: unknown) => ipcRenderer.invoke('puddle:window-transfer-observe', request),
      accept: (request: unknown) => ipcRenderer.invoke('puddle:window-transfer-accept', request),
      focusPane: (request: unknown) => ipcRenderer.invoke('puddle:window-focus-pane', request),
      dockTargets: (profileId: string) =>
        ipcRenderer.invoke('puddle:window-dock-targets', { profileId }),
      prepareDock: (request: unknown) => ipcRenderer.invoke('puddle:window-prepare-dock', request),
      retire: (request: unknown) => ipcRenderer.invoke('puddle:window-transfer-retire', request),
      beginPaneDrag: (request: unknown) =>
        ipcRenderer.invoke('puddle:window-begin-pane-drag', request),
      dropPane: (request: unknown) => ipcRenderer.invoke('puddle:window-drop-pane', request),
    },
    lifecycle: {
      ready: () => ipcRenderer.invoke('puddle:window-ready'),
      onCommand: (callback: (command: unknown) => void) => {
        const handler = (_event: unknown, command: unknown) => callback(command);
        ipcRenderer.on('puddle:window-command', handler);
        return () => ipcRenderer.removeListener('puddle:window-command', handler);
      },
      reply: (reply: unknown) => ipcRenderer.invoke('puddle:window-reply', reply),
    },
  },
  notificationStatus: () => ipcRenderer.invoke('puddle:notification-status'),
  showNotification: (request: unknown) => ipcRenderer.invoke('puddle:notification-show', request),
  notificationTargets: true,
  notificationSubtitles: true,
  onNotificationClick: (callback: (id: string, target: unknown) => void): (() => void) => {
    const handler = (_event: unknown, id: string, target: unknown) => callback(id, target);
    ipcRenderer.on('puddle:notification-click', handler);
    return () => ipcRenderer.removeListener('puddle:notification-click', handler);
  },
  /** Bring the app window to the front (renderer window.focus() cannot). */
  raiseWindow: () => ipcRenderer.send('puddle:raise'),
  /** Close this window — the `window.close` hotkey (renderer close() cannot). */
  closeWindow: () => ipcRenderer.send('puddle:close-window'),
  /** The staged update's version, or null — for banners mounting late. */
  updateReady: (): Promise<string | null> => ipcRenderer.invoke('puddle:update-ready'),
  /** Fires when a poll stages an update; returns the unsubscribe. */
  onUpdateReady: (callback: (version: string) => void): (() => void) => {
    const handler = (_event: unknown, version: string) => callback(version);
    ipcRenderer.on('puddle:update-ready', handler);
    return () => ipcRenderer.removeListener('puddle:update-ready', handler);
  },
  /** Quit, swap the install, relaunch — the banner's "Restart to update". */
  installUpdate: () => ipcRenderer.send('puddle:install-update'),
  /**
   * Whether this window is full-screen — a window fact the renderer cannot read.
   * The top bar insets for the inlaid macOS traffic lights, which are hidden in
   * full-screen, so it needs to know (ShellLayout).
   */
  isFullScreen: (): Promise<boolean> => ipcRenderer.invoke('puddle:is-fullscreen'),
  /** Fires on enter/leave full-screen with the new state; returns the unsubscribe. */
  onFullScreenChange: (callback: (full: boolean) => void): (() => void) => {
    const handler = (_event: unknown, full: boolean) => callback(full);
    ipcRenderer.on('puddle:fullscreen', handler);
    return () => ipcRenderer.removeListener('puddle:fullscreen', handler);
  },
  onWindowFocusChange: (callback: (focused: boolean) => void): (() => void) => {
    const handler = (_event: unknown, focused: boolean) => callback(focused);
    ipcRenderer.on('puddle:window-focus', handler);
    return () => ipcRenderer.removeListener('puddle:window-focus', handler);
  },
});

// Appearance is a shell concern, not an application API. Observe the cockpit's
// existing setting without exposing another callable bridge to page scripts.
window.addEventListener('DOMContentLoaded', () => {
  const report = () => {
    try {
      const theme = localStorage.getItem('puddle.theme');
      if (theme === 'light' || theme === 'dark' || theme === 'system')
        ipcRenderer.send('puddle:appearance', theme);
    } catch {
      // A disabled storage area leaves native prompts on their last preference.
    }
  };
  report();
  new MutationObserver(report).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  window.addEventListener('focus', report);
});

// The main process binds this presentation snapshot to the window's target.
window.addEventListener('DOMContentLoaded', () => {
  let previous = '';
  const report = () => {
    const value = document.documentElement.dataset.desktopHostIdentity;
    if (!value || value === previous || value.length > 32_768) return;
    try {
      ipcRenderer.send('puddle:host-identity', JSON.parse(value));
      previous = value;
    } catch {
      // Incomplete or invalid projections leave the last-known identity intact.
    }
  };
  report();
  new MutationObserver(report).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-desktop-host-identity'],
  });
  window.addEventListener('focus', report);
});
