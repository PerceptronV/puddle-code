import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The windows the desktop should bring back on its next launch: targets only
 * ('local' or user@host, never credentials). This lives in `~/.puddle` beside
 * recent-hosts.json, so ordinary quits, machine restarts, app updates, and
 * reinstalls all preserve the same set of cockpit windows.
 */

interface WindowState {
  /** Present only in the former one-shot update state. */
  writtenAt?: string;
  targets: string[];
}

const LEGACY_TTL_MS = 15 * 60 * 1000;

export function saveWindowTargets(file: string, targets: string[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const state: WindowState = { targets };
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // Best-effort: inability to remember shell chrome must never block quit.
  }
}

/** Read the standing window set. Corrupt or absent state means a fresh launch. */
export function loadWindowTargets(file: string, now = Date.now()): string[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<WindowState>;
    if (!Array.isArray(parsed.targets)) return [];
    // Before durable restore this file was a one-shot update hand-off. Keep
    // its original TTL during migration: a failed update from months ago must
    // not suddenly become a standing window set after installing this build.
    if (parsed.writtenAt !== undefined) {
      const writtenAt = Date.parse(parsed.writtenAt);
      if (!Number.isFinite(writtenAt) || now - writtenAt >= LEGACY_TTL_MS) return [];
    }
    return [...new Set(parsed.targets.filter((t): t is string => typeof t === 'string'))];
  } catch {
    // Corrupt — treat as absent.
    return [];
  }
}
