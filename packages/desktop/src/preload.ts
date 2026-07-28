import { contextBridge, ipcRenderer } from 'electron';

/**
 * The one bridge the web app gets from the desktop shell. Its presence is
 * also the web's "running under the desktop app" signal (notification
 * permission handling differs there — see use-waiting-notifications).
 * Built as CJS (preload scripts run sandboxed).
 */
contextBridge.exposeInMainWorld('puddleDesktop', {
  /** Bring the app window to the front (renderer window.focus() cannot). */
  raiseWindow: () => ipcRenderer.send('puddle:raise'),
});
