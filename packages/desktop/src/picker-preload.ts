import type { HostIdentity } from './host-identities.js';
import { contextBridge, ipcRenderer } from 'electron';

/** Bridge for the new-window host picker (host-picker.html). */
contextBridge.exposeInMainWorld('puddlePicker', {
  /** Local followed by recent SSH targets, with last-known host presentation. */
  recents: (): Promise<{ target: string; identity: HostIdentity | null }[]> =>
    ipcRenderer.invoke('puddle:picker-recents'),
  onHosts: (callback: (hosts: { target: string; identity: HostIdentity | null }[]) => void) => {
    ipcRenderer.on('puddle:picker-hosts', (_event, hosts) => callback(hosts));
  },
  choose: (target: string) => ipcRenderer.send('puddle:picker-choose', target),
  /** Hand over to the Connect to SSH Host prompt for a target not listed. */
  other: () => ipcRenderer.send('puddle:picker-other'),
  cancel: () => ipcRenderer.send('puddle:picker-cancel'),
  onStatus: (cb: (status: { state: 'connecting' | 'error'; message?: string }) => void) => {
    ipcRenderer.on('puddle:picker-status', (_event, status) => cb(status));
  },
});
