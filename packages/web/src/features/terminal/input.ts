import { browserScope, browserTransport } from '../../lib/browser-transport';
import { wsManager } from '../../lib/ws';
import { useSyncExternalStore } from 'react';

type PasteEncoder = (text: string) => string;
const encoders = new Map<string, PasteEncoder>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const changed = () => {
  for (const listener of listeners) listener();
};
const key = (session: string, term: string) => browserScope(JSON.stringify([session, term]));
export function useTerminalInputReady(session: string, term: string): boolean {
  return useSyncExternalStore(subscribe, () => encoders.has(key(session, term)));
}
export function registerTerminalInput(
  session: string,
  term: string,
  encode: PasteEncoder,
): () => void {
  const id = key(session, term);
  encoders.set(id, encode);
  changed();
  return () => {
    if (encoders.get(id) === encode) {
      encoders.delete(id);
      changed();
    }
  };
}
export async function sendTerminalInput(
  session: string,
  term: string,
  text: string,
  paste = false,
): Promise<void> {
  const encode = encoders.get(key(session, term));
  if (!encode) throw new Error('Wait for the terminal to attach; nothing was sent');
  const data = paste ? `${encode(text)}\r` : text;
  const remote = browserTransport();
  if (remote) await remote.input(session, term, data);
  else {
    if (!wsManager.isConnected()) throw new Error('Terminal is disconnected; nothing was sent');
    wsManager.write(session, term, data);
  }
}
