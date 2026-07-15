import { execFile } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentAdapter, AgentUsage } from './adapter.js';
import { claudeConversationShare } from './claude-share.js';
import { installStatusLine, readLiveUsage } from './claude-statusline.js';
import { fetchSubscriptionUsage } from './claude-usage-cli.js';

const execFileAsync = promisify(execFile);

/**
 * Per-file token subtotals keyed by absolute path, invalidated on
 * (size, mtimeMs) change — conversation JSONLs only ever grow, so a warm
 * cache reparses nothing and a live session's file is re-read only when it
 * has actually changed since the last usage call.
 */
const usageCache = new Map<string, { size: number; mtimeMs: number; usage: AgentUsage }>();

const EMPTY_USAGE: AgentUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  message_count: 0,
};

/**
 * Claude Code adapter.
 *
 * Flags verified against Claude Code 2.1.208 (2026-07-14):
 * - `--session-id <uuid>` accepted at launch ("must be a valid UUID") → we
 *   preset it to the puddle session id, so agent_session_ref === sessions.id.
 * - `--resume <uuid>` restores a conversation; a positional prompt after it
 *   is submitted on resume (used for the interrupted-restart note). A ref
 *   with no conversation file fails with "No conversation found" (exit 1).
 * - `--dangerously-skip-permissions` bypasses permission prompts, but ONLY once
 *   the config dir records `bypassPermissionsModeAccepted: true` in .claude.json.
 *   Without it, 2.1.x silently downgrades the flag to default ("Permission mode
 *   downgraded to default — bypass requires accepting the disclaimer
 *   interactively first"), so a non-interactive PTY session keeps its prompts.
 *   The disclaimer is otherwise an interactive dialog; puddle writes the flag
 *   only when the user opens the profile skip gate — see acceptSkipPermissions
 *   (verified against Claude Code 2.1.210).
 * - `claude auth login` / `auth status` drive the login flow. auth login
 *   writes `oauthAccount` into `<config_dir>/.claude.json` but does NOT set
 *   `hasCompletedOnboarding` — only the TUI's first-run wizard does. An
 *   unset flag makes the first session run that wizard (theme → sign-in
 *   AGAIN → trust), and the wizard DISCARDS a preset `--session-id`, which
 *   also breaks resume. Hence prepareConfigDir seeds the flag at account
 *   creation, before anything else runs.
 * - macOS keychain OAuth entries are bound to the config-dir PATH: renaming
 *   or copying the dir silently logs the account out while .claude.json still
 *   carries oauthAccount (verified 2.1.208 — migration 004's dir rename did
 *   exactly this). Hence checkLoggedIn asks `auth status` instead of trusting
 *   any stored flag. The login screen, like the wizard, DISCARDS a preset
 *   --session-id — discoverSessionRef recovers the conversation by the cwd
 *   recorded in its JSONL.
 * - `claude -p /usage` prints the subscription rate-limit windows as plain
 *   text (verified 2.1.209) — see claude-usage-cli.ts, including the
 *   API-key-suppresses-the-windows gotcha.
 * - `CLAUDE_CONFIG_DIR` relocates all state: conversation JSONL lands at
 *   `<config_dir>/projects/<escaped-realpath-cwd>/<uuid>.jsonl`. For a git
 *   WORKTREE cwd the project dir is escaped from the MAIN repository root,
 *   not the worktree path — so conversation lookup scans every project dir
 *   rather than computing the escaped name.
 */
export const claudeCode: AgentAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  binary: 'claude',
  capabilities: {
    resume: true,
    presetSessionId: true,
    skipPermissions: true,
    migratableSessions: true,
  },

  env(account) {
    return { CLAUDE_CONFIG_DIR: account.config_dir };
  },

  prepareConfigDir(configDir) {
    // The dir is puddle-created and empty at this point; auth login and the
    // TUI merge into this file rather than replacing it.
    writeFileSync(
      join(configDir, '.claude.json'),
      `${JSON.stringify({ hasCompletedOnboarding: true }, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    installStatusLine(configDir); // live-usage capture (context fill, cost)
  },

  async importConfigDir(sourceDir, configDir) {
    // Bytes are copied opaquely — nothing is parsed except .claude.json,
    // which needs the same onboarding seed as a fresh dir. On macOS the
    // OAuth token is keychain-bound to the ORIGINAL dir path and does not
    // travel; checkLoggedIn reports the truth afterwards.
    await cp(sourceDir, configDir, { recursive: true });
    const stateFile = join(configDir, '.claude.json');
    let state: Record<string, unknown> = {};
    if (existsSync(stateFile)) {
      try {
        state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
      } catch {
        // An unreadable state file gets replaced by the minimal seed.
      }
    }
    state['hasCompletedOnboarding'] = true;
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    installStatusLine(configDir); // respects an imported account's own statusLine
  },

  acceptSkipPermissions(account) {
    // The user has opened the profile skip-permissions gate (SPEC §11) — the
    // human confirmation. Record Claude's dangerous-mode disclaimer acceptance
    // so `--dangerously-skip-permissions` actually bypasses prompts; otherwise
    // 2.1.x downgrades it to default in a non-interactive PTY. Merge so
    // oauthAccount and everything else in .claude.json survive.
    const file = join(account.config_dir, '.claude.json');
    let state: Record<string, unknown> = {};
    if (existsSync(file)) {
      try {
        state = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      } catch {
        // An unreadable file is replaced by the minimal record.
      }
    }
    state['bypassPermissionsModeAccepted'] = true;
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  },

  async checkLoggedIn(account) {
    try {
      const { stdout } = await execFileAsync('claude', ['auth', 'status'], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: account.config_dir },
        timeout: 15_000,
      });
      const status = JSON.parse(stdout) as { loggedIn?: boolean };
      return status.loggedIn === true;
    } catch {
      return false; // no binary / timeout / unparsable → not verifiably logged in
    }
  },

  discoverSessionRef(worktreePath, account) {
    const projectsDir = join(account.config_dir, 'projects');
    if (!existsSync(projectsDir)) return null;
    const targets = new Set([worktreePath]);
    try {
      targets.add(realpathSync(worktreePath)); // /var vs /private/var on macOS
    } catch {
      // A vanished worktree still matches on the recorded string.
    }
    let best: { ref: string; mtime: number } | null = null;
    for (const dir of readdirSync(projectsDir)) {
      let files: string[];
      try {
        files = readdirSync(join(projectsDir, dir));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const path = join(projectsDir, dir, file);
        if (!conversationCwdMatches(path, targets)) continue;
        const mtime = statSync(path).mtimeMs;
        // Newest wins: a worktree can host successive conversations.
        if (!best || mtime > best.mtime) best = { ref: file.slice(0, -'.jsonl'.length), mtime };
      }
    }
    return best?.ref ?? null;
  },

  hasConversation(ref, account) {
    const projectsDir = join(account.config_dir, 'projects');
    if (!existsSync(projectsDir)) return false;
    return readdirSync(projectsDir).some((dir) =>
      existsSync(join(projectsDir, dir, `${ref}.jsonl`)),
    );
  },

  sessionTitle(ref, account) {
    const projectsDir = join(account.config_dir, 'projects');
    if (!existsSync(projectsDir)) return null;
    for (const dir of readdirSync(projectsDir)) {
      const path = join(projectsDir, dir, `${ref}.jsonl`);
      if (existsSync(path)) return readSessionTitle(path);
    }
    return null;
  },

  usageStats(account) {
    const projectsDir = join(account.config_dir, 'projects');
    if (!existsSync(projectsDir)) return null;
    const total = { ...EMPTY_USAGE };
    let sawFile = false;
    for (const dir of readdirSync(projectsDir)) {
      let files: string[];
      try {
        files = readdirSync(join(projectsDir, dir));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        sawFile = true;
        addUsage(total, fileUsage(join(projectsDir, dir, file)));
      }
    }
    return sawFile ? total : null;
  },

  liveUsage(account) {
    return readLiveUsage(account.config_dir);
  },

  // Shared conversation store hooks (Workstream S); see claude-share.ts for the
  // pinned verification block. Consequence: after adoption every account of the
  // profile reads the SAME conversation JSONLs through its symlink, so
  // usageStats/hasConversation report identical conversations for them all.
  conversationShare: claudeConversationShare,

  subscriptionUsage(account) {
    return fetchSubscriptionUsage(account);
  },

  reconcileConfigDir(account) {
    // Bring pre-existing accounts up to the current setup (idempotent, and
    // it never clobbers a status line the account already defines).
    if (existsSync(account.config_dir)) installStatusLine(account.config_dir);
  },

  launchArgs(opts) {
    return [
      '--session-id',
      opts.sessionId,
      ...(opts.skipPermissions ? ['--dangerously-skip-permissions'] : []),
      ...(opts.prompt !== undefined ? [opts.prompt] : []),
    ];
  },

  resumeArgs(ref, opts) {
    return [
      '--resume',
      ref,
      ...(opts.skipPermissions ? ['--dangerously-skip-permissions'] : []),
      ...(opts.prompt !== undefined ? [opts.prompt] : []),
    ];
  },

  loginArgs() {
    return ['auth', 'login'];
  },

  async resolveSessionRef(opts) {
    return opts.sessionId; // preset via --session-id
  },

  statusPatterns: {
    // Initial heuristics for the 2.1.x TUI; refine during the Phase 1
    // acceptance run against real output. The bordered input box renders
    // "│ >" when idle; "esc to interrupt" is shown while working.
    waitingInput: [/│\s?>/],
    busy: [/esc to interrupt/i],
    limitReached: [/usage limit reached/i, /out of extra usage/i],
  },
};

/** Bounded window read for the transcript title scan (large transcripts). */
const TITLE_WINDOW = 128 * 1024;

/**
 * The session's own name from its transcript: the last explicit `agent-name`
 * (the user named it) if present, else the last generated `ai-title` — what
 * Claude Code's resume picker shows. Normalised to a single ≤80-char line;
 * null when absent (e.g. before the first exchange).
 *
 * Verified against Claude Code 2.1.210 (2026-07-14): the transcript carries
 * `{type:"ai-title", aiTitle}` shortly after the first exchange and, when the
 * session is named, `{type:"agent-name", agentName}`. A regenerated title is
 * appended, so the newest lives near the tail; the first lands early (~line
 * 15). We read a bounded tail window and fall back to the head only when a
 * since-grown transcript's tail holds no title line — so an early title is
 * never lost, and the read stays bounded regardless of file size.
 */
function readSessionTitle(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    let title = pickTitle(readTranscriptChunk(fd, Math.max(0, size - TITLE_WINDOW), TITLE_WINDOW));
    if (title === null && size > TITLE_WINDOW)
      title = pickTitle(readTranscriptChunk(fd, 0, TITLE_WINDOW));
    return title;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function readTranscriptChunk(fd: number, start: number, length: number): string {
  const buf = Buffer.allocUnsafe(length);
  const read = readSync(fd, buf, 0, length, start);
  return buf.toString('utf8', 0, read);
}

/** Newest agent-name (preferred) or ai-title in a transcript chunk, normalised. */
function pickTitle(text: string): string | null {
  let aiTitle: string | null = null;
  let agentName: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"ai-title"') && !line.includes('"agent-name"')) continue;
    try {
      const rec = JSON.parse(line) as { type?: string; aiTitle?: unknown; agentName?: unknown };
      if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') aiTitle = rec.aiTitle;
      else if (rec.type === 'agent-name' && typeof rec.agentName === 'string')
        agentName = rec.agentName;
    } catch {
      // Partial line at a window boundary — ignore.
    }
  }
  const raw = agentName ?? aiTitle;
  if (raw === null) return null;
  const norm = raw.trim().replace(/\s+/g, ' ').slice(0, 80);
  return norm === '' ? null : norm;
}

/** The conversation's cwd appears within the first few JSONL records. */
function conversationCwdMatches(path: string, targets: Set<string>): boolean {
  let head: string;
  try {
    head = readFileSync(path, 'utf8').slice(0, 16_384);
  } catch {
    return false;
  }
  for (const line of head.split('\n').slice(0, 10)) {
    try {
      const record = JSON.parse(line) as { cwd?: string };
      if (record.cwd !== undefined && targets.has(record.cwd)) return true;
    } catch {
      // Partial trailing line inside the head window — ignore.
    }
  }
  return false;
}

function addUsage(into: AgentUsage, more: AgentUsage): void {
  into.input_tokens += more.input_tokens;
  into.output_tokens += more.output_tokens;
  into.cache_read_input_tokens += more.cache_read_input_tokens;
  into.cache_creation_input_tokens += more.cache_creation_input_tokens;
  into.message_count += more.message_count;
}

/** Cached per-file token subtotal; reparses only when (size, mtime) changed. */
function fileUsage(path: string): AgentUsage {
  let stat: { size: number; mtimeMs: number };
  try {
    stat = statSync(path);
  } catch {
    return EMPTY_USAGE;
  }
  const cached = usageCache.get(path);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.usage;
  }
  const usage = { ...EMPTY_USAGE };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return EMPTY_USAGE;
  }
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    let record: { type?: string; message?: { usage?: Record<string, number> } };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue; // a partial trailing line from a live writer
    }
    if (record.type !== 'assistant') continue;
    const u = record.message?.usage;
    if (!u) continue;
    usage.message_count += 1;
    usage.input_tokens += u['input_tokens'] ?? 0;
    usage.output_tokens += u['output_tokens'] ?? 0;
    usage.cache_read_input_tokens += u['cache_read_input_tokens'] ?? 0;
    usage.cache_creation_input_tokens += u['cache_creation_input_tokens'] ?? 0;
  }
  usageCache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, usage });
  return usage;
}
