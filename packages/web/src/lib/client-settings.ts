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
   * project instead of one profile-wide surface.
   */
  projectBasedLayout: boolean;
  /**
   * Whether the right sidebar lists every project's sessions (grouped by
   * project) or only the current project's. Independent of
   * `projectBasedLayout` since 2026-08-03 — the two were one setting through
   * v0.0.24, which forced a per-project editor layout on anyone who wanted a
   * focused session list, and vice versa (see the load() migration).
   */
  showAllProjectSessions: boolean;
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
  showAllProjectSessions: true,
};

const KEY = 'puddle.client-settings';
const listeners = new Set<() => void>();
let cache: ClientSettings | null = null;

/**
 * The two settings that used to be one, reconciled in both directions so a
 * stored choice survives the split (2026-08-03) and nothing flips under anyone:
 *
 *  - a snapshot from before `projectBasedLayout` existed carries only
 *    `showAllProjectSessions`; its OFF state is what project-based layout came
 *    to mean, so it seeds the layout setting;
 *  - a snapshot from v0.0.22–v0.0.24 carries only `projectBasedLayout`, and it
 *    was scoping that window's sidebar too — so it seeds the sidebar setting,
 *    which keeps the window looking exactly as it did until either is changed.
 *
 * Exported for the unit test; `load` is the only caller.
 */
export function reconcileProjectScopeSettings(
  stored: Partial<ClientSettings>,
): Partial<ClientSettings> {
  const out = { ...stored };
  if (out.projectBasedLayout === undefined && out.showAllProjectSessions !== undefined) {
    out.projectBasedLayout = !out.showAllProjectSessions;
  }
  if (out.showAllProjectSessions === undefined && out.projectBasedLayout !== undefined) {
    out.showAllProjectSessions = !out.projectBasedLayout;
  }
  return out;
}

function load(): ClientSettings {
  if (cache) return cache;
  let stored: Partial<ClientSettings> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<ClientSettings>;
  } catch {
    // Corrupt JSON → fall back to defaults.
  }
  cache = { ...DEFAULT_CLIENT_SETTINGS, ...reconcileProjectScopeSettings(stored) };
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
