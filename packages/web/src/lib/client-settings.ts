import { useSyncExternalStore } from 'react';

/**
 * Client-scope settings (SPEC §11): per-browser, in localStorage. Profile and
 * daemon scopes live server-side and have their own settings sections.
 */
export interface ClientSettings {
  uiFontSize: number;
  terminalFontSize: number;
  density: 'compact' | 'comfortable';
  /** Forces reduced motion even when the OS does not request it. */
  reducedMotion: boolean;
  terminalScrollback: number;
  /** Editor keys are stored now, consumed when the editor lands in Phase 3. */
  editorTabSize: number;
  editorWordWrap: boolean;
}

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  // 1.1× the browser default (16px) — the whole rem-based scale follows.
  uiFontSize: 17.6,
  terminalFontSize: 13,
  density: 'compact',
  reducedMotion: false,
  terminalScrollback: 5000,
  editorTabSize: 2,
  editorWordWrap: false,
};

const KEY = 'puddle.client-settings';
const listeners = new Set<() => void>();
let cache: ClientSettings | null = null;

function load(): ClientSettings {
  if (cache) return cache;
  let stored: Partial<ClientSettings> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<ClientSettings>;
  } catch {
    // Corrupt JSON → fall back to defaults.
  }
  cache = { ...DEFAULT_CLIENT_SETTINGS, ...stored };
  return cache;
}

/** Non-colour knobs still flow through CSS variables / data attributes. */
function applyToDocument(settings: ClientSettings): void {
  document.documentElement.style.setProperty('--ui-font-size', `${settings.uiFontSize}px`);
  document.documentElement.dataset['reducedMotion'] = String(settings.reducedMotion);
}

export function clientSettings(): ClientSettings {
  return load();
}

export function updateClientSettings(patch: Partial<ClientSettings>): void {
  cache = { ...load(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(cache));
  applyToDocument(cache);
  for (const listener of listeners) listener();
}

export function initClientSettings(): void {
  applyToDocument(load());
}

export function useClientSettings(): ClientSettings {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => load(),
  );
}
