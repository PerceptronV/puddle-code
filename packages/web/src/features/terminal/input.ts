import { browserScope, browserTransport } from '../../lib/browser-transport';
import { wsManager } from '../../lib/ws';
import { useSyncExternalStore } from 'react';
import { isArrowInput, touchModifiedInput } from './touch-modifiers';

type PasteEncoder = (text: string) => string;
const encoders = new Map<string, PasteEncoder>();
const focusers = new Map<string, () => void>();
const modifiers = new Map<string, number>();
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
  focus?: () => void,
): () => void {
  const id = key(session, term);
  encoders.set(id, encode);
  if (focus) focusers.set(id, focus);
  changed();
  return () => {
    if (encoders.get(id) === encode) {
      encoders.delete(id);
      focusers.delete(id);
      modifiers.delete(id);
      changed();
    }
  };
}
export function focusTerminal(session: string, term: string): void {
  focusers.get(key(session, term))?.();
}
export function useTerminalModifiers(session: string, term: string): number {
  return useSyncExternalStore(subscribe, () => modifiers.get(key(session, term)) ?? 0);
}
export function toggleTerminalModifier(session: string, term: string, bit: number): void {
  const id = key(session, term);
  modifiers.set(id, (modifiers.get(id) ?? 0) ^ bit);
  changed();
}
export function consumeTerminalModifiers(session: string, term: string, data: string): string {
  const id = key(session, term);
  const value = modifiers.get(id) ?? 0;
  if (!value) return data;
  // Device-query replies and mouse reports are not user keystrokes.
  if (data.startsWith('\x1b') && !isArrowInput(data)) return data;
  modifiers.delete(id);
  changed();
  return touchModifiedInput(data, value);
}
export async function sendTerminalInput(
  session: string,
  term: string,
  text: string,
  paste = false,
): Promise<void> {
  const encode = encoders.get(key(session, term));
  if (!encode) throw new Error('Wait for the terminal to attach; nothing was sent');
  const data = paste ? `${encode(text)}\r` : consumeTerminalModifiers(session, term, text);
  const remote = browserTransport();
  if (remote) await remote.input(session, term, data);
  else {
    if (!wsManager.isConnected()) throw new Error('Terminal is disconnected; nothing was sent');
    wsManager.write(session, term, data);
  }
}
