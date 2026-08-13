import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentAdapter } from './adapter.js';

const execFileAsync = promisify(execFile);

/** Subdirectories of the account config dir that back opencode's XDG roots. */
const CONFIG_HOME = 'config';
const DATA_HOME = 'data';
const CACHE_HOME = 'cache';
const STATE_HOME = 'state';
const SESSION_START_WINDOW_MS = 5 * 60 * 1000;

/**
 * OpenCode adapter.
 *
 * Verified against opencode 1.18.10 (2026-07-31) with `--help` and
 * `opencode debug paths` on a scratch install:
 * - **Isolation is XDG-based, and needs four variables.** opencode splits its
 *   state across `~/.config/opencode`, `~/.local/share/opencode` (which holds
 *   `auth.json` AND the session store), `~/.cache/opencode` and
 *   `~/.local/state/opencode`. `debug paths` confirms `XDG_CONFIG_HOME`,
 *   `XDG_DATA_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME` relocate all of them.
 *   **`OPENCODE_CONFIG_DIR` relocates NOTHING** — verified: with it set, every
 *   reported path stayed at the real `~/…`. It is for agent/command/plugin
 *   discovery only and is useless for account isolation, so it is not used here.
 * - Caveat: `XDG_CONFIG_HOME` is not opencode-specific, so git commands the
 *   agent runs no longer see `$XDG_CONFIG_HOME/git/*`. Verified that identity
 *   survives — `user.name`/`user.email` come from `~/.gitconfig`, which is
 *   HOME-based — but a user's XDG-located global gitignore will not apply
 *   inside opencode sessions. Accepted: credential isolation matters more.
 * - `--auto` = "auto-approve permissions that are not explicitly denied
 *   (dangerous!)", so `skipPermissions: true`. SPEC §5 previously said
 *   opencode's permissions were "configured rather than flagged"; that is out
 *   of date and has been corrected.
 * - `-s/--session <id>` continues a session, `-c/--continue` the last one, and
 *   `--prompt <text>` seeds the first message. Session ids are `ses_`-prefixed
 *   and minted by opencode, so `presetSessionId: false`.
 * - Auth is `opencode providers`, aliased **`auth`**: `auth login` / `auth list`
 *   / `auth logout`. `auth list` reports configured providers; checkLoggedIn
 *   treats "at least one provider" as authenticated.
 * - `opencode export <sessionID>` emits the session as JSON — a first-class
 *   transcript source, so exportTranscript shells out rather than parsing the
 *   on-disk store.
 *
 * No `conversationShare`: sessions are per-project JSON files under the data
 * dir rather than per-conversation directories, so the Workstream S store model
 * does not apply and `migratableSessions` is false.
 */
export const opencode: AgentAdapter = {
  id: 'opencode',
  displayName: 'OpenCode',
  binary: 'opencode',
  capabilities: {
    resume: true,
    presetSessionId: false,
    skipPermissions: true,
    migratableSessions: false,
  },

  env(account) {
    return xdgEnv(account.config_dir);
  },

  prepareConfigDir(configDir) {
    // opencode creates its own <root>/opencode subdirs; the XDG roots must exist.
    for (const sub of [CONFIG_HOME, DATA_HOME, CACHE_HOME, STATE_HOME]) {
      mkdirSync(join(configDir, sub), { recursive: true });
    }
  },

  launchArgs(opts) {
    return [
      ...(opts.skipPermissions ? ['--auto'] : []),
      ...(opts.prompt !== undefined ? ['--prompt', opts.prompt] : []),
    ];
  },

  resumeArgs(ref, opts) {
    return [
      '--session',
      ref,
      ...(opts.skipPermissions ? ['--auto'] : []),
      ...(opts.prompt !== undefined ? ['--prompt', opts.prompt] : []),
    ];
  },

  loginArgs() {
    // Deliberately NOT the bare TUI (unlike claude-code/codex/gemini-cli,
    // decision 2026-08-06): `auth login` is opencode's own interactive
    // provider picker, renders entirely in the PTY, and exits cleanly on its
    // own once the credential is saved — exactly what the login dialogue
    // wants, with no REPL to escape from.
    return ['auth', 'login'];
  },

  async checkLoggedIn(account) {
    try {
      const { stdout } = await execFileAsync('opencode', ['auth', 'list'], {
        env: { ...process.env, ...xdgEnv(account.config_dir) },
        timeout: 15_000,
      });
      // `auth list` exits 0 whether or not anything is configured, so the
      // signal is the credential store itself plus a non-empty listing.
      return authFileHasProvider(account.config_dir) || /\S/.test(stripHeading(stdout));
    } catch {
      return false; // missing binary / timeout / unparsable
    }
  },

  existingSessionRefs(worktreePath, account) {
    return new Set(sessionsFor(account.config_dir, worktreePath).map((session) => session.id));
  },

  async resolveSessionRef(opts, account, excludeRefs = new Set()) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const ref = newestSessionId(account.config_dir, opts.worktreePath, excludeRefs);
      if (ref !== null) return ref;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    // Placeholder; the resume path re-discovers the real ref by worktree.
    return opts.sessionId;
  },

  discoverSessionRef(worktreePath, account, context) {
    const candidates = sessionsFor(account.config_dir, worktreePath).filter(
      (session) => !context?.excludeRefs?.has(session.id),
    );
    if (context === undefined) return candidates[0]?.id ?? null;
    return sessionBornFor(candidates, context.createdAt)?.id ?? null;
  },

  hasConversation(ref, account) {
    return sessionsFor(account.config_dir).some((session) => session.id === ref);
  },

  sessionRefMatches(ref, context, account) {
    return (
      sessionBornFor(
        sessionsFor(account.config_dir, context.worktreePath).filter(
          (candidate) => !context.excludeRefs?.has(candidate.id),
        ),
        context.createdAt,
      )?.id === ref
    );
  },

  async exportTranscript(ref, account) {
    try {
      const { stdout } = await execFileAsync('opencode', ['export', ref], {
        env: { ...process.env, ...xdgEnv(account.config_dir) },
        timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      return renderExport(stdout);
    } catch {
      return ''; // caller falls back to the PTY log tail
    }
  },

  /**
   * UNVERIFIED against a live session (opencode needs a configured provider to
   * reach its composer). Confirm via docs/acceptance/phase-7-agents.md and
   * correct here — opencode has no hook side-channel, so these are its only
   * status driver.
   */
  statusPatterns: {
    waitingInput: [/esc\s+interrupt/i, /^\s*>\s*$/m],
    busy: [/working/i, /thinking/i],
  },
};

/** The four XDG roots, all under the account's puddle-owned config dir. */
function xdgEnv(configDir: string): Record<string, string> {
  return {
    XDG_CONFIG_HOME: join(configDir, CONFIG_HOME),
    XDG_DATA_HOME: join(configDir, DATA_HOME),
    XDG_CACHE_HOME: join(configDir, CACHE_HOME),
    XDG_STATE_HOME: join(configDir, STATE_HOME),
  };
}

/** opencode's own data root inside the account dir. */
function dataDir(configDir: string): string {
  return join(configDir, DATA_HOME, 'opencode');
}

function authFileHasProvider(configDir: string): boolean {
  try {
    const raw = readFileSync(join(dataDir(configDir), 'auth.json'), 'utf8');
    return Object.keys(JSON.parse(raw) as Record<string, unknown>).length > 0;
  } catch {
    return false;
  }
}

/** Drops `auth list`'s banner/heading lines so "no providers" reads as empty. */
function stripHeading(stdout: string): string {
  return stdout
    .split('\n')
    .filter((line) => !/^\s*(#|─|━|Credentials|Providers)/i.test(line))
    .join('\n');
}

/**
 * Newest session id recorded for `worktreePath`.
 *
 * The store lives under `<data>/opencode/storage/session/<project>/<ses_*>.json`.
 * The exact project keying is opencode's own and is not reproduced here: every
 * session file is read and matched on the directory it records, so a layout
 * change costs a scan rather than a wrong answer. Returns null when nothing
 * matches — including when the layout is not what this expects, which the
 * acceptance script exists to catch.
 */
interface StoredSession {
  id: string;
  directory: string;
  createdAt: number | null;
  updatedAt: number;
}

function sessionsFor(configDir: string, worktreePath?: string): StoredSession[] {
  const root = join(dataDir(configDir), 'storage', 'session');
  if (!existsSync(root)) return [];
  const found: StoredSession[] = [];
  for (const file of walkJson(root, 3)) {
    const name = file.split('/').pop() ?? '';
    if (!name.startsWith('ses_') || !name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(readFileSync(file, 'utf8')) as {
        id?: string;
        directory?: string;
        cwd?: string;
        time?: { updated?: number; created?: number };
      };
      const dir = record.directory ?? record.cwd;
      if (dir === undefined || (worktreePath !== undefined && dir !== worktreePath)) continue;
      const id = record.id ?? name.slice(0, -'.json'.length);
      found.push({
        id,
        directory: dir,
        createdAt: normaliseEpoch(record.time?.created),
        updatedAt:
          normaliseEpoch(record.time?.updated) ?? normaliseEpoch(record.time?.created) ?? 0,
      });
    } catch {
      /* unreadable or unexpected shape — skip */
    }
  }
  return found.sort((a, b) => b.updatedAt - a.updatedAt);
}

function newestSessionId(
  configDir: string,
  worktreePath: string,
  excludeRefs: ReadonlySet<string> = new Set(),
): string | null {
  return (
    sessionsFor(configDir, worktreePath).find((session) => !excludeRefs.has(session.id))?.id ?? null
  );
}

function sessionBornFor<T extends { createdAt: number | null }>(
  candidates: T[],
  sessionCreatedAt: string,
): T | undefined {
  const createdAt = Date.parse(sessionCreatedAt);
  if (!Number.isFinite(createdAt)) return undefined;
  const ranked = candidates
    .filter(
      (candidate) =>
        candidate.createdAt !== null &&
        candidate.createdAt >= createdAt - 5_000 &&
        candidate.createdAt <= createdAt + SESSION_START_WINDOW_MS,
    )
    .sort((a, b) => Math.abs(a.createdAt! - createdAt) - Math.abs(b.createdAt! - createdAt));
  const best = ranked[0];
  const second = ranked[1];
  if (
    best !== undefined &&
    second !== undefined &&
    Math.abs(second.createdAt! - createdAt) - Math.abs(best.createdAt! - createdAt) < 15_000
  ) {
    return undefined; // too close to prove ownership safely
  }
  return best;
}

/** OpenCode currently stores epoch milliseconds; tolerate seconds from older builds. */
function normaliseEpoch(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return value < 10_000_000_000 ? value * 1000 : value;
}

/** Absolute paths of every .json file under `dir`, to a bounded depth. */
function walkJson(dir: string, depth: number): string[] {
  if (depth < 0) return [];
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJson(path, depth - 1));
    else if (entry.name.endsWith('.json')) out.push(path);
  }
  return out;
}

/**
 * `opencode export` JSON → readable text. Only user/assistant text parts are
 * kept; tool invocations collapse to a count, matching the other adapters.
 */
function renderExport(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return stdout.trim(); // not JSON after all — better than nothing
  }
  const messages = extractMessages(parsed);
  if (messages === null) return '';
  const out: string[] = [];
  let toolCalls = 0;
  const flushTools = () => {
    if (toolCalls > 0) out.push(`_(ran ${toolCalls} tool call${toolCalls === 1 ? '' : 's'})_`);
    toolCalls = 0;
  };
  for (const message of messages) {
    const role = message.role === 'user' ? 'User' : 'Assistant';
    const text: string[] = [];
    for (const part of message.parts ?? []) {
      if (part.type === 'tool' || part.type === 'tool-invocation') toolCalls++;
      else if (typeof part.text === 'string' && part.text.trim() !== '')
        text.push(part.text.trim());
    }
    if (text.length === 0) continue;
    flushTools();
    out.push(`## ${role}\n\n${text.join('\n\n')}`);
  }
  flushTools();
  return out.join('\n\n');
}

interface ExportedMessage {
  role?: string;
  parts?: Array<{ type?: string; text?: string }>;
}

function extractMessages(parsed: unknown): ExportedMessage[] | null {
  if (Array.isArray(parsed)) return parsed as ExportedMessage[];
  if (parsed !== null && typeof parsed === 'object') {
    const messages = (parsed as { messages?: unknown }).messages;
    if (Array.isArray(messages)) return messages as ExportedMessage[];
  }
  return null;
}
