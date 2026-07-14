import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter } from './adapter.js';

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
