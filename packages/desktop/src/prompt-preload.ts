import { contextBridge, ipcRenderer } from 'electron';

/** Bridge for the connect-to-host prompt window (connect-prompt.html). */
contextBridge.exposeInMainWorld('puddlePrompt', {
  submit: (host: string) => ipcRenderer.send('puddle:connect-submit', host),
  cancel: () => ipcRenderer.send('puddle:connect-cancel'),
  onStatus: (cb: (status: { state: 'connecting' | 'error'; message?: string }) => void) => {
    ipcRenderer.on('puddle:connect-status', (_event, status) => cb(status));
  },
});
