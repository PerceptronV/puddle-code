import { useSyncExternalStore } from 'react';
import { desktopBridge } from './desktop';

/**
 * The app's customisable keyboard shortcuts (SPEC §11). One registry of actions,
 * each with a default binding and a runtime handler a component registers on
 * mount; a single global dispatcher (installed by `HotkeysHost`) turns a keydown
 * into the matching action. Filetree navigation and terminal line-edits stay
 * fixed and are deliberately NOT here (SPEC §11 "global actions only").
 *
 * A binding is a canonical string: the modifiers `ctrl`/`alt`/`shift`/`meta` in
 * that fixed order, then a `KeyboardEvent.code` (e.g. `meta+shift+KeyE`,
 * `ctrl+Backquote`), so it is keyboard-layout-independent.
 *
 * Two default sets (SPEC §11): the web defaults avoid combos browser chrome
 * would swallow; the DESKTOP shell — no chrome competing for keys — forks the
 * few where a native gesture is more intuitive (`desktopBinding`). Only the
 * defaults fork: a per-profile override applies in both shells.
 */
export interface HotkeyAction {
  id: string;
  label: string;
  group: string;
  defaultBinding: string;
  /** Desktop-shell default, where it differs from the web-safe one. */
  desktopBinding?: string;
  /** Bound inside Monaco (not the DOM dispatcher) — the editor owns the keys. */
  editor?: boolean;
  /** Yield to a focused terminal, which uses this key itself (e.g. ⌃A, ⌃`). */
  deferInTerminal?: boolean;
}

export const HOTKEY_GROUPS = ['Layout & tabs', 'Editor', 'Left sidebar', 'Right sidebar'] as const;

export const HOTKEY_ACTIONS: HotkeyAction[] = [
  {
    id: 'palette.toggle',
    label: 'Command palette',
    group: 'Layout & tabs',
    defaultBinding: 'meta+KeyK',
  },
  {
    id: 'tab.close',
    label: 'Close current tab',
    group: 'Layout & tabs',
    defaultBinding: 'ctrl+alt+KeyW',
    // The native close gesture; the shell's Close Window yields it (⌘⇧W).
    desktopBinding: 'meta+KeyW',
  },
  {
    id: 'tab.reopen',
    label: 'Reopen last closed tab',
    group: 'Layout & tabs',
    // ⌘⇧T is the browser's own reopen-closed-tab and never reaches the page,
    // so the web default follows `tab.close`'s ⌃⌥ pattern instead.
    defaultBinding: 'ctrl+alt+KeyT',
    desktopBinding: 'meta+shift+KeyT',
  },
  {
    id: 'window.close',
    label: 'Close window',
    group: 'Layout & tabs',
    // Naming the browser's own ⌘W is honest rather than useful: a tab cannot
    // intercept it (SPEC §11), and the chrome closes the window either way.
    defaultBinding: 'meta+KeyW',
    // The desktop shell's File → Close, which yields plain ⌘W to `tab.close`.
    desktopBinding: 'meta+shift+KeyW',
  },
  {
    id: 'sidebar.left',
    label: 'Toggle left sidebar',
    group: 'Layout & tabs',
    defaultBinding: 'alt+meta+Comma',
    // VSCode's primary-sidebar toggle.
    desktopBinding: 'meta+KeyB',
  },
  {
    id: 'sidebar.right',
    label: 'Toggle right sidebar',
    group: 'Layout & tabs',
    defaultBinding: 'alt+meta+Period',
  },
  { id: 'editor.save', label: 'Save', group: 'Editor', defaultBinding: 'meta+KeyS', editor: true },
  {
    id: 'editor.wordWrap',
    label: 'Toggle word wrap',
    group: 'Editor',
    defaultBinding: 'alt+KeyZ',
    editor: true,
  },
  {
    id: 'nav.files',
    label: 'Open Files',
    group: 'Left sidebar',
    defaultBinding: 'alt+meta+KeyE',
  },
  {
    id: 'nav.search',
    label: 'Open Search',
    group: 'Left sidebar',
    defaultBinding: 'alt+meta+KeyF',
  },
  {
    id: 'nav.changes',
    label: 'Open Changes',
    group: 'Left sidebar',
    defaultBinding: 'alt+meta+KeyV',
  },
  {
    id: 'nav.worktrees',
    label: 'Open Worktrees',
    group: 'Left sidebar',
    defaultBinding: 'alt+meta+KeyB',
  },
  {
    id: 'session.newAgent',
    label: 'New agent',
    group: 'Right sidebar',
    defaultBinding: 'ctrl+alt+Backquote',
    // "New tab" muscle memory — the primary new-thing here is an agent.
    desktopBinding: 'meta+KeyT',
  },
  {
    id: 'session.newTerminal',
    label: 'New terminal',
    group: 'Right sidebar',
    defaultBinding: 'ctrl+Backquote',
  },
  {
    id: 'scratchpad.toggle',
    label: 'Toggle Scratchpad',
    group: 'Right sidebar',
    defaultBinding: 'alt+meta+KeyS',
  },
  {
    id: 'layouts.toggle',
    label: 'Toggle Layouts',
    group: 'Right sidebar',
    defaultBinding: 'alt+meta+KeyL',
  },
];

const ACTION_BY_ID = new Map(HOTKEY_ACTIONS.map((a) => [a.id, a]));

/**
 * Which default set this window uses — evaluated once at import (the preload
 * bridge exists before any script runs). The `typeof window` guard keeps the
 * module importable under plain-Node vitest.
 */
const IS_DESKTOP = typeof window !== 'undefined' && desktopBridge() !== undefined;

/** The shell's default binding for an action: the desktop fork when in the shell, else the web-safe one. */
export function shellDefaultBinding(action: HotkeyAction, desktop: boolean = IS_DESKTOP): string {
  return desktop && action.desktopBinding ? action.desktopBinding : action.defaultBinding;
}

/** The canonical binding a keydown maps to, or null for a bare modifier press. */
export function eventBinding(e: KeyboardEvent): string | null {
  const code = e.code;
  if (!code || /^(Control|Alt|Shift|Meta)(Left|Right)$/.test(code)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey) parts.push('meta');
  if (parts.length === 0) return null; // plain keys are never app hotkeys
  parts.push(code);
  return parts.join('+');
}

const SYMBOL: Record<string, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' };
const CODE_LABEL: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Backquote: '`',
  Slash: '/',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Space: '␣',
  Enter: '↵',
  Escape: 'Esc',
};
function codeLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return CODE_LABEL[code] ?? code;
}

/** A binding string as its Mac glyphs, e.g. `meta+shift+KeyE` → `⌘⇧E`. */
export function formatBinding(binding: string): string {
  if (!binding) return '—';
  const parts = binding.split('+');
  const code = parts.pop() ?? '';
  const mods = parts.map((m) => SYMBOL[m] ?? m).join('');
  return mods + codeLabel(code);
}

// --- runtime handler registry (components register on mount) ---
const handlers = new Map<string, () => void>();
export function registerHotkey(id: string, handler: () => void): () => void {
  handlers.set(id, handler);
  return () => {
    if (handlers.get(id) === handler) handlers.delete(id);
  };
}
export const getHotkeyHandler = (id: string): (() => void) | undefined => handlers.get(id);
export const getHotkeyAction = (id: string): HotkeyAction | undefined => ACTION_BY_ID.get(id);

// --- merged bindings store (defaults overridden by the profile's settings) ---
let overrides: Record<string, string> = {};
const listeners = new Set<() => void>();
let bindingsSnapshot: Record<string, string> = mergeBindings();

function mergeBindings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of HOTKEY_ACTIONS) out[a.id] = overrides[a.id] || shellDefaultBinding(a);
  return out;
}

/** Called by `HotkeysHost` when the profile's hotkey overrides change. */
export function setHotkeyOverrides(next: Record<string, string> | undefined): void {
  overrides = next ?? {};
  bindingsSnapshot = mergeBindings();
  listeners.forEach((l) => l());
}

/** The effective binding for an action (override, else default). */
export const hotkeyBinding = (id: string): string => bindingsSnapshot[id] ?? '';

/** action-id for a given binding string, or undefined — for the dispatcher. */
export function actionForBinding(binding: string): string | undefined {
  for (const [id, b] of Object.entries(bindingsSnapshot)) if (b === binding) return id;
  return undefined;
}

/**
 * An action's effective binding as Mac glyphs (`⌘K`), re-rendering when the
 * profile rebinds it. Every place that NAMES a shortcut in UI copy — the top
 * bar's palette hint, an empty pane, an empty session list, the homescreen, the
 * draft-save prompts — reads it from here rather than hard-coding the default,
 * so a rebind is honest everywhere at once (SPEC §11). Actions deliberately
 * left out of the registry (filetree ops, terminal line-edits) still spell
 * their fixed keys literally; those cannot be rebound.
 */
export function useHotkeyLabel(id: string): string {
  return formatBinding(useHotkeyBindings()[id] ?? '');
}

/** Subscribe to the effective bindings (React) — re-render on rebind. */
export function useHotkeyBindings(): Record<string, string> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => bindingsSnapshot,
  );
}
