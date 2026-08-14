import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Geometry saved independently of Electron so persistence stays testable. */
export interface PersistedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowPlacement {
  /** Normal (unmaximised, non-full-screen) window bounds. */
  bounds: PersistedBounds;
  /** Electron's display id; preferred when that display still exists. */
  displayId?: number;
  /** Human-readable display label; fallback when ids change across boots. */
  displayLabel?: string;
  /** Former work area, used to preserve the window's monitor-relative offset. */
  displayWorkArea?: PersistedBounds;
  /** EWMH virtual-desktop index. Linux/X11 only; absent everywhere else. */
  workspace?: number;
}

export interface ReopenWindow {
  target: string;
  placement?: WindowPlacement;
}

/**
 * The windows the desktop should bring back on its next launch. Targets are
 * 'local' or user@host, never credentials. Placement is shell chrome only and
 * deliberately best-effort: macOS/X11 restore monitor geometry, X11 also
 * restores the EWMH workspace, and native Wayland ignores placement.
 *
 * This lives in `~/.puddle` beside recent-hosts.json, so ordinary quits,
 * machine restarts, app updates, and reinstalls preserve the same set.
 */
interface WindowState {
  /** Present only in the former one-shot update state. */
  writtenAt?: string;
  /** Current shape. */
  windows?: unknown[];
  /** Pre-placement standing state, and the still-older update hand-off. */
  targets?: unknown[];
}

const LEGACY_TTL_MS = 15 * 60 * 1000;
const MAX_WORKSPACE = 0xffff_fffe; // 0xFFFFFFFF means "all desktops" in EWMH

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseBounds(value: unknown): PersistedBounds | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const bounds = value as Record<string, unknown>;
  if (
    !finite(bounds['x']) ||
    !finite(bounds['y']) ||
    !finite(bounds['width']) ||
    !finite(bounds['height']) ||
    bounds['width'] <= 0 ||
    bounds['height'] <= 0
  ) {
    return undefined;
  }
  return {
    x: bounds['x'],
    y: bounds['y'],
    width: bounds['width'],
    height: bounds['height'],
  };
}

function parsePlacement(value: unknown): WindowPlacement | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const bounds = parseBounds(candidate['bounds']);
  if (!bounds) return undefined;
  const displayId = candidate['displayId'];
  const displayLabel = candidate['displayLabel'];
  const displayWorkArea = parseBounds(candidate['displayWorkArea']);
  const workspace = candidate['workspace'];
  return {
    bounds,
    ...(typeof displayId === 'number' && Number.isSafeInteger(displayId) ? { displayId } : {}),
    ...(typeof displayLabel === 'string' && displayLabel.length > 0 ? { displayLabel } : {}),
    ...(displayWorkArea ? { displayWorkArea } : {}),
    ...(typeof workspace === 'number' &&
    Number.isInteger(workspace) &&
    workspace >= 0 &&
    workspace <= MAX_WORKSPACE
      ? { workspace }
      : {}),
  };
}

function parseWindows(values: unknown[]): ReopenWindow[] {
  const windows: ReopenWindow[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'object' || value === null) continue;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate['target'] !== 'string' || seen.has(candidate['target'])) continue;
    seen.add(candidate['target']);
    const placement = parsePlacement(candidate['placement']);
    windows.push({ target: candidate['target'], ...(placement ? { placement } : {}) });
  }
  return windows;
}

export function saveReopenWindows(file: string, windows: ReopenWindow[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const state: WindowState = { windows: parseWindows(windows) };
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // Best-effort: inability to remember shell chrome must never block quit.
  }
}

/** Read the standing window set. Corrupt or absent state means a fresh launch. */
export function loadReopenWindows(file: string, now = Date.now()): ReopenWindow[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<WindowState>;
    // Before durable restore this file was a one-shot update hand-off. Keep
    // its original TTL during migration: a failed update from months ago must
    // not suddenly become a standing window set after installing this build.
    if (parsed.writtenAt !== undefined) {
      const writtenAt = Date.parse(parsed.writtenAt);
      if (!Number.isFinite(writtenAt) || now - writtenAt >= LEGACY_TTL_MS) return [];
    }
    if (Array.isArray(parsed.windows)) return parseWindows(parsed.windows);
    if (!Array.isArray(parsed.targets)) return [];
    return [
      ...new Set(parsed.targets.filter((target): target is string => typeof target === 'string')),
    ].map((target) => ({ target }));
  } catch {
    // Corrupt — treat as absent.
    return [];
  }
}
