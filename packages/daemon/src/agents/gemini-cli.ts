import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter } from './adapter.js';

/** gemini-cli hardcodes this directory name under its (overridable) home. */
const GEMINI_DIR = '.gemini';

/**
 * Gemini CLI adapter.
 *
 * Verified against @google/gemini-cli 0.53.1 (2026-07-31) with `--help` and a
 * scratch-install probe:
 * - **Isolation is `GEMINI_CLI_HOME`, not a config-dir variable.** gemini-cli
 *   hardcodes `.gemini` and resolves its parent through its own `homedir()`,
 *   which checks `GEMINI_CLI_HOME` before `os.homedir()`. Verified: with it set,
 *   `<dir>/.gemini/{projects.json,history/,tmp/}` appeared there. The widely
 *   cited **`GEMINI_CONFIG_DIR` does NOTHING** — verified: with it set the CLI
 *   still read the real `~/.gemini/settings.json`, which would violate SPEC §2
 *   by writing into a config dir puddle did not create. Do not switch to it.
 * - `--session-id <uuid>` ("Start a new session with a manually provided UUID")
 *   means ids ARE presettable, so `presetSessionId: true` and
 *   `agent_session_ref === sessions.id`, as for claude-code.
 * - `-r/--resume` is documented as `latest` or an index (`--resume 5`). Whether
 *   it also accepts a full UUID is **unverified** (needs an authenticated run)
 *   and is the main open risk here — see docs/acceptance/phase-7-agents.md. If
 *   it turns out to be index-only, resume must map the ref to an index via
 *   `--list-sessions` instead.
 * - `-i/--prompt-interactive <text>` seeds a prompt and stays interactive.
 *   `-p/--prompt` is HEADLESS (prints and exits), so using it for a session
 *   would make every session exit immediately.
 * - Both `-y/--yolo` and `--approval-mode {default,auto_edit,yolo,plan}` exist;
 *   the explicit mode is used as the newer, unambiguous spelling.
 * - **There is no `auth` subcommand** (only mcp/extensions/skills/hooks/gemma),
 *   so there is no `gemini auth login` or `auth status`. Login is the first-run
 *   interactive picker: loginArgs launches the TUI bare and the user completes
 *   it, and checkLoggedIn inspects the credentials file instead of asking the
 *   CLI. Unauthenticated runs fail with "Please set an Auth method in your
 *   <home>/.gemini/settings.json …".
 * - Projects are keyed in `<home>/.gemini/projects.json` (absolute cwd → short
 *   name) with per-project `history/<name>/` and `tmp/<name>/` dirs.
 *
 * No `conversationShare` and `migratableSessions: false`: chats are per-project
 * files, not per-conversation directories.
 */
export const geminiCli: AgentAdapter = {
  id: 'gemini-cli',
  displayName: 'Gemini CLI',
  binary: 'gemini',
  capabilities: {
    resume: true,
    presetSessionId: true,
    skipPermissions: true,
    migratableSessions: false,
  },

  env(account) {
    return { GEMINI_CLI_HOME: account.config_dir };
  },

  launchArgs(opts) {
    return [
      '--session-id',
      opts.sessionId,
      ...(opts.skipPermissions ? ['--approval-mode', 'yolo'] : []),
      // --prompt is headless and would exit immediately; -i stays interactive.
      ...(opts.prompt !== undefined ? ['--prompt-interactive', opts.prompt] : []),
    ];
  },

  resumeArgs(ref, opts) {
    return [
      '--resume',
      ref,
      ...(opts.skipPermissions ? ['--approval-mode', 'yolo'] : []),
      ...(opts.prompt !== undefined ? ['--prompt-interactive', opts.prompt] : []),
    ];
  },

  loginArgs() {
    // No auth subcommand: a bare launch shows the first-run auth picker.
    return [];
  },
  loginHint:
    'Complete the auth picker on Gemini’s own screen. When you are done, press Ctrl+C twice to close the agent and finish.',

  async checkLoggedIn(account) {
    // Asking the CLI is not an option (no status command), so the credential
    // file is the signal. Presence only — never read the token itself.
    const dir = geminiDir(account.config_dir);
    return (
      existsSync(join(dir, 'oauth_creds.json')) ||
      existsSync(join(dir, 'google_accounts.json')) ||
      settingsHasAuth(dir)
    );
  },

  async resolveSessionRef(opts) {
    return opts.sessionId; // preset via --session-id
  },

  discoverSessionRef(worktreePath, account) {
    const dir = chatsDir(account.config_dir, worktreePath);
    if (dir === null) return null;
    let best: { id: string; mtimeMs: number } | null = null;
    for (const name of safeReaddir(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const mtimeMs = statSync(join(dir, name)).mtimeMs;
        const id = name.slice(0, -'.json'.length);
        if (best === null || mtimeMs > best.mtimeMs) best = { id, mtimeMs };
      } catch {
        /* vanished between readdir and stat */
      }
    }
    return best?.id ?? null;
  },

  /**
   * UNVERIFIED against a live session — gemini-cli needs an auth method before
   * it renders its composer. Confirm via docs/acceptance/phase-7-agents.md.
   * There is no hook side-channel, so these are the only status driver.
   */
  statusPatterns: {
    waitingInput: [/Type your message/i, /esc\s+to\s+cancel/i],
    busy: [/esc\s+to\s+cancel/i],
  },
};

function geminiDir(configDir: string): string {
  return join(configDir, GEMINI_DIR);
}

/** An API-key or Vertex auth method recorded in settings counts as logged in. */
function settingsHasAuth(dir: string): boolean {
  try {
    const raw = readFileSync(join(dir, 'settings.json'), 'utf8');
    return /"(selectedAuthType|security)"/.test(raw);
  } catch {
    return false;
  }
}

/**
 * The chats directory for `worktreePath`, resolved through the CLI's own
 * `projects.json` map (absolute cwd → short project name) rather than by
 * recomputing its hashing. Null when the project has not been seen yet.
 */
function chatsDir(configDir: string, worktreePath: string): string | null {
  const dir = geminiDir(configDir);
  let name: string | undefined;
  try {
    const raw = readFileSync(join(dir, 'projects.json'), 'utf8');
    const map = (JSON.parse(raw) as { projects?: Record<string, string> }).projects ?? {};
    name = map[worktreePath];
  } catch {
    return null;
  }
  if (name === undefined) return null;
  // Observed layout is tmp/<name>/; chats/ is the documented subdirectory.
  for (const candidate of [
    join(dir, 'tmp', name, 'chats'),
    join(dir, 'history', name, 'chats'),
    join(dir, 'tmp', name),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
