import { contextBridge, ipcRenderer } from 'electron';

/** Bridge for the new-window host picker (host-picker.html). */
contextBridge.exposeInMainWorld('puddlePicker', {
  /** Recent ssh targets, most recent first — 'local' is the picker's own row. */
  recents: (): Promise<string[]> => ipcRenderer.invoke('puddle:picker-recents'),
  choose: (target: string) => ipcRenderer.send('puddle:picker-choose', target),
  /** Hand over to the Connect to SSH Host prompt for a target not listed. */
  other: () => ipcRenderer.send('puddle:picker-other'),
  cancel: () => ipcRenderer.send('puddle:picker-cancel'),
  onStatus: (cb: (status: { state: 'connecting' | 'error'; message?: string }) => void) => {
    ipcRenderer.on('puddle:picker-status', (_event, status) => cb(status));
  },
});
