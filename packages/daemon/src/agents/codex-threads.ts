import Database from 'better-sqlite3';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Codex's own session index — `$CODEX_HOME/state_<n>.sqlite`, a `threads` table
 * keyed by the same uuid as the rollout file.
 *
 * Verified against codex-cli 0.146.0 (2026-08-01), reading a real state_5:
 * - `name` is the session's own name — what `codex resume`/`archive` accept as
 *   an alternative to the uuid, and what a rename sets. Empty until named.
 * - `title` / `preview` / `first_user_message` all hold the FIRST USER MESSAGE
 *   verbatim and untruncated (8 KiB in one sampled row) — codex writes no short
 *   curated title the way Claude Code does, so this is a fallback to be cut
 *   down, not a display string.
 *
 * Read-only and best-effort. The filename carries a schema version, so a codex
 * upgrade can rename or reshape it out from under us; everything here fails to
 * `null`, which just leaves the session on its previous name.
 */

/** Newest `state_<n>.sqlite` under the config dir, or null. */
function stateDbPath(configDir: string): string | null {
  let best: { path: string; version: number } | null = null;
  let names: string[];
  try {
    names = readdirSync(configDir);
  } catch {
    return null;
  }
  for (const name of names) {
    const match = /^state_(\d+)\.sqlite$/.exec(name);
    if (match === null) continue;
    const version = Number(match[1]);
    if (best === null || version > best.version) best = { path: join(configDir, name), version };
  }
  return best?.path ?? null;
}

/**
 * The display name codex would show for `ref`: its own session name when one is
 * set, else the opening user message cut to a single ≤80-char line. Null when
 * the thread is unknown or the index cannot be read.
 *
 * Opened and closed per call rather than held: the file is another process's
 * live database and its name is version-stamped, so keeping a handle across a
 * codex upgrade would pin a stale (or deleted) file. A single indexed lookup a
 * few times a minute costs nothing.
 */
export function threadTitle(configDir: string, ref: string): string | null {
  const path = stateDbPath(configDir);
  if (path === null || !existsSync(path)) return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const row = db.prepare('select name, title from threads where id = ?').get(ref) as
      { name?: string | null; title?: string | null } | undefined;
    if (row === undefined) return null;
    return oneLine(row.name) ?? oneLine(row.title);
  } catch {
    return null; // missing table, schema drift, locked, unreadable — all the same answer
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing useful to do */
    }
  }
}

/** Collapse to a single ≤80-char line, matching the claude-code adapter. */
function oneLine(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const norm = raw.trim().replace(/\s+/g, ' ').slice(0, 80);
  return norm === '' ? null : norm;
}
