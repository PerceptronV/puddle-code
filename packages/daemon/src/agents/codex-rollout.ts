import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reading codex's rollout files — the JSONL transcripts it writes per session.
 *
 * Layout verified against codex-cli 0.146.0 (2026-07-31):
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO8601>-<uuid>.jsonl`, where line 1
 * is a `session_meta` record carrying the session `id` and the `cwd` it ran in.
 */

export interface RolloutMeta {
  id: string;
  cwd: string;
}

interface RolloutLine {
  type?: string;
  payload?: { type?: string; id?: string; cwd?: string; message?: string; text?: string };
}

/** Every rollout file under the account's config dir, newest mtime first. */
export function rolloutFiles(configDir: string): string[] {
  const root = join(configDir, 'sessions');
  if (!existsSync(root)) return [];
  const found: Array<{ path: string; mtimeMs: number }> = [];
  // sessions/YYYY/MM/DD/*.jsonl — a fixed three-level date bucket.
  for (const year of subdirs(root)) {
    const yearDir = join(root, year);
    for (const month of subdirs(yearDir)) {
      const monthDir = join(yearDir, month);
      for (const day of subdirs(monthDir)) {
        const dayDir = join(monthDir, day);
        for (const name of safeReaddir(dayDir)) {
          if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
          const path = join(dayDir, name);
          try {
            found.push({ path, mtimeMs: statSync(path).mtimeMs });
          } catch {
            /* vanished between readdir and stat */
          }
        }
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map((f) => f.path);
}

/** The `session_meta` header of a rollout, or null when unreadable. */
export function readRolloutMeta(path: string): RolloutMeta | null {
  try {
    // Only the first line matters; rollouts grow to megabytes, so read a slice.
    const head = readFileSync(path, 'utf8').slice(0, 64 * 1024);
    const line = head.split('\n', 1)[0];
    if (line === undefined || line.trim() === '') return null;
    const record = JSON.parse(line) as RolloutLine;
    const id = record.payload?.id;
    const cwd = record.payload?.cwd;
    return id !== undefined && cwd !== undefined ? { id, cwd } : null;
  } catch {
    return null;
  }
}

/** Newest rollout recorded against `worktreePath`, or undefined. */
export function newestRolloutFor(configDir: string, worktreePath: string): RolloutMeta | undefined {
  for (const path of rolloutFiles(configDir)) {
    const meta = readRolloutMeta(path);
    if (meta !== null && meta.cwd === worktreePath) return meta;
  }
  return undefined;
}

/**
 * The conversation as readable text for a cross-agent hand-off (SPEC §5).
 * Only the user/agent message pair is rendered: reasoning records are the
 * agent's private thinking (tier 2 is "degraded by design"), and tool payloads
 * are bulky, so a run of them collapses to a single count line.
 */
export function renderRollout(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return '';
  }
  const out: string[] = [];
  let toolCalls = 0;
  const flushTools = () => {
    if (toolCalls > 0) out.push(`_(ran ${toolCalls} tool call${toolCalls === 1 ? '' : 's'})_`);
    toolCalls = 0;
  };
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let record: RolloutLine;
    try {
      record = JSON.parse(line) as RolloutLine;
    } catch {
      continue;
    }
    if (record.type !== 'event_msg' && record.type !== 'response_item') continue;
    const kind = record.payload?.type;
    if (kind === 'function_call' || kind === 'custom_tool_call') {
      toolCalls++;
      continue;
    }
    if (record.type !== 'event_msg') continue;
    if (kind !== 'user_message' && kind !== 'agent_message') continue;
    const text = (record.payload?.message ?? record.payload?.text ?? '').trim();
    if (text === '') continue;
    flushTools();
    out.push(`## ${kind === 'user_message' ? 'User' : 'Assistant'}\n\n${text}`);
  }
  flushTools();
  return out.join('\n\n');
}

function subdirs(dir: string): string[] {
  return safeReaddir(dir).filter((name) => {
    try {
      return statSync(join(dir, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
