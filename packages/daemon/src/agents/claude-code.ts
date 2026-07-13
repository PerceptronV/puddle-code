import type { AgentAdapter } from './adapter.js';

/**
 * Claude Code adapter.
 *
 * Flags verified against Claude Code 2.1.207 (2026-07-13):
 * - `--session-id <uuid>` accepted at launch ("must be a valid UUID") → we
 *   preset it to the puddle session id, so agent_session_ref === sessions.id.
 * - `--resume <uuid>` restores a conversation; a positional prompt after it
 *   is submitted on resume (used for the interrupted-restart note).
 * - `--dangerously-skip-permissions` skips permission prompts.
 * - `claude auth login` / `auth status` drive the login flow.
 * - `CLAUDE_CONFIG_DIR` relocates all state (verified empirically: a fresh
 *   dir receives .claude.json and conversation JSONL under
 *   projects/<escaped-cwd>/<uuid>.jsonl).
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
