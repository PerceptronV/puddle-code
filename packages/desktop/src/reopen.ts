import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The windows an update restart should bring back: written (targets only —
 * 'local' or user@host, never credentials) as the "Restart to update" swap
 * begins, consumed one-shot by the next launch. In `~/.puddle` beside
 * recent-hosts.json — durable client state that survives the very app swap
 * it exists for. A short TTL keeps a leftover from a FAILED swap from
 * resurrecting windows days later: the helper relaunches within seconds, so
 * anything old is stale by definition.
 */

const TTL_MS = 15 * 60 * 1000;

interface ReopenState {
  writtenAt: string;
  targets: string[];
}

export function saveReopenTargets(file: string, targets: string[]): void {
  if (targets.length === 0) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const state: ReopenState = { writtenAt: new Date().toISOString(), targets };
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // Best-effort: the update matters more than the window restore.
  }
}

/** Read AND delete — reopening is a one-launch affair, never a standing rule. */
export function consumeReopenTargets(file: string, now = Date.now()): string[] {
  if (!existsSync(file)) return [];
  let targets: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ReopenState>;
    const writtenAt = Date.parse(parsed.writtenAt ?? '');
    const fresh = Number.isFinite(writtenAt) && now - writtenAt < TTL_MS;
    if (fresh && Array.isArray(parsed.targets)) {
      targets = parsed.targets.filter((t): t is string => typeof t === 'string');
    }
  } catch {
    // Corrupt — treat as absent.
  }
  try {
    rmSync(file, { force: true });
  } catch {
    // An undeletable file must not block the launch.
  }
  return targets;
}
