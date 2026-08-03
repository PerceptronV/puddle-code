import { useSyncExternalStore } from 'react';

/**
 * Client-scope settings (SPEC §11): per-browser, in localStorage. Profile and
 * daemon scopes live server-side and have their own settings sections.
 */
export interface ClientSettings {
  uiFontSize: number;
  terminalFontSize: number;
  /** Monaco text size; intentionally independent from the terminal size. */
  editorFontSize: number;
  density: 'compact' | 'comfortable';
  terminalScrollback: number;
  /** Editor keys are stored now, consumed when the editor lands in Phase 3. */
  editorTabSize: number;
  editorWordWrap: boolean;
  /** `user@host` for `vscode://`/`cursor://` remote deep links; `''` = unset. */
  editorLinkSshHost: string;
  /**
   * Project-based layout (SPEC §11): the centre editor keeps a layout per
   * project (and the sidebar lists only the current project's sessions)
   * instead of one profile-wide surface. Replaces the inverse
   * `showAllProjectSessions` (see the load() migration).
   */
  projectBasedLayout: boolean;
}

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  // 1.1× the browser default (16px) — the whole rem-based scale follows.
  uiFontSize: 16,
  terminalFontSize: 13,
  editorFontSize: 14,
  density: 'compact',
  terminalScrollback: 5000,
  editorTabSize: 2,
  editorWordWrap: false,
  editorLinkSshHost: '',
  projectBasedLayout: false,
};

const KEY = 'puddle.client-settings';
const listeners = new Set<() => void>();
let cache: ClientSettings | null = null;

function load(): ClientSettings {
  if (cache) return cache;
  let stored: Partial<ClientSettings> & { showAllProjectSessions?: boolean } = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as typeof stored;
  } catch {
    // Corrupt JSON → fall back to defaults.
  }
  // Migrate the retired `showAllProjectSessions` (default on): its OFF state —
  // only the current project's sessions in the sidebar — is what project-based
  // layout now means, so carry that choice over rather than resetting it.
  if (stored.projectBasedLayout === undefined && stored.showAllProjectSessions !== undefined) {
    stored.projectBasedLayout = !stored.showAllProjectSessions;
  }
  delete stored.showAllProjectSessions;
  cache = { ...DEFAULT_CLIENT_SETTINGS, ...stored };
  return cache;
}

/** Non-colour knobs still flow through CSS variables / data attributes. */
function applyToDocument(settings: ClientSettings): void {
  document.documentElement.style.setProperty('--ui-font-size', `${settings.uiFontSize}px`);
  // Drives the `compact:` utilities (app.css @custom-variant).
  document.documentElement.dataset['density'] = settings.density;
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
