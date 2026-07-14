import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentAdapter } from './adapter.js';

const execFileAsync = promisify(execFile);

/**
 * Claude Code adapter.
 *
 * Flags verified against Claude Code 2.1.208 (2026-07-14):
 * - `--session-id <uuid>` accepted at launch ("must be a valid UUID") → we
 *   preset it to the puddle session id, so agent_session_ref === sessions.id.
 * - `--resume <uuid>` restores a conversation; a positional prompt after it
 *   is submitted on resume (used for the interrupted-restart note). A ref
 *   with no conversation file fails with "No conversation found" (exit 1).
 * - `--dangerously-skip-permissions` skips permission prompts.
 * - `claude auth login` / `auth status` drive the login flow. auth login
 *   writes `oauthAccount` into `<config_dir>/.claude.json` but does NOT set
 *   `hasCompletedOnboarding` — only the TUI's first-run wizard does. An
 *   unset flag makes the first session run that wizard (theme → sign-in
 *   AGAIN → trust), and the wizard DISCARDS a preset `--session-id`, which
 *   also breaks resume. Hence prepareConfigDir seeds the flag at account
 *   creation, before anything else runs.
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

  hasConversation(ref, account) {
    const projectsDir = join(account.config_dir, 'projects');
    if (!existsSync(projectsDir)) return false;
    return readdirSync(projectsDir).some((dir) =>
      existsSync(join(projectsDir, dir, `${ref}.jsonl`)),
    );
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
