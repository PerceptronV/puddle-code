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
  /** Bring the app window to the front (renderer window.focus() cannot). */
  raiseWindow: () => ipcRenderer.send('puddle:raise'),
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
});
