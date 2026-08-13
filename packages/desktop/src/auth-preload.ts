import { contextBridge, ipcRenderer } from 'electron';

/** Bridge for the one-shot SSH password/2FA/confirmation window. */
contextBridge.exposeInMainWorld('puddleSshAuth', {
  submit: (answer: string) => ipcRenderer.send('puddle:ssh-auth-submit', answer),
  cancel: () => ipcRenderer.send('puddle:ssh-auth-cancel'),
  onRequest: (cb: (request: { prompt: string; kind: 'secret' | 'confirm' }) => void) => {
    ipcRenderer.on('puddle:ssh-auth-request', (_event, request) => cb(request));
  },
});
