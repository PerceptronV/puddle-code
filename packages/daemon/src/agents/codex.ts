import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { promisify } from 'node:util';
import type { AgentAdapter } from './adapter.js';
import { newestRolloutFor, renderRollout, rolloutFiles } from './codex-rollout.js';

const execFileAsync = promisify(execFile);

/**
 * Codex adapter.
 *
 * Flags verified against codex-cli 0.146.0 (2026-07-31), `--help` on a scratch
 * install:
 * - `CODEX_HOME` relocates config, sessions and credentials together (verified:
 *   the CLI warns when the path is missing and creates its `tmp/` there). One
 *   variable is enough, unlike opencode.
 * - `--dangerously-bypass-approvals-and-sandbox` is the skip-permissions flag.
 *   **`--yolo` does NOT exist in 0.146.0** despite appearing in published docs;
 *   only the long form is accepted. `resume` accepts the flag too, so it is
 *   passed on both paths — but openai/codex#9144 reports it is not always
 *   HONOURED on resume, which is a runtime check (see docs/acceptance).
 * - `codex resume [SESSION_ID] [PROMPT]` — both positional; also `--last`,
 *   `--all`. Flags are emitted before the positionals.
 * - `codex login` opens the interactive flow; `codex login status` **exits 1
 *   when logged out** (verified) and 0 when logged in, so the exit code alone
 *   drives checkLoggedIn — no output parsing.
 * - Session ids are NOT presettable: codex mints its own rollout id, so
 *   `presetSessionId: false` and `agent_session_ref !== sessions.id` — the
 *   first adapter where those diverge. resolveSessionRef polls briefly for the
 *   rollout file; if it has not appeared it returns the puddle session id as a
 *   placeholder, which `hasConversation` reports as missing so the normal
 *   resume recovery path re-discovers the real ref by cwd.
 * - Rollouts live at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
 *   (verified against real files). Line 1 is a `session_meta` record whose
 *   payload carries `id` and **`cwd`** — the field conversation lookup matches.
 *
 * No `conversationShare`: rollouts are date-bucketed files, not per-conversation
 * directories, so the Workstream S store model does not apply and
 * `migratableSessions` is false (tier-1 migration returns the documented
 * `409 migration_unsupported`; tier-2 hand-off still works).
 */
export const codex: AgentAdapter = {
  id: 'codex',
  displayName: 'Codex',
  binary: 'codex',
  capabilities: {
    resume: true,
    presetSessionId: false,
    skipPermissions: true,
    migratableSessions: false,
  },

  env(account) {
    return { CODEX_HOME: account.config_dir };
  },

  launchArgs(opts) {
    return [
      ...(opts.skipPermissions ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
      ...(opts.prompt !== undefined ? [opts.prompt] : []),
    ];
  },

  resumeArgs(ref, opts) {
    // `resume [SESSION_ID] [PROMPT]`: flags first, then the positionals in order.
    return [
      'resume',
      ...(opts.skipPermissions ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
      ref,
      ...(opts.prompt !== undefined ? [opts.prompt] : []),
    ];
  },

  loginArgs() {
    return ['login'];
  },

  async checkLoggedIn(account) {
    try {
      // Exits 0 logged in, 1 logged out (verified 0.146.0). execFile rejects on
      // a non-zero exit, so reaching the return means authenticated.
      await execFileAsync('codex', ['login', 'status'], {
        env: { ...process.env, CODEX_HOME: account.config_dir },
        timeout: 15_000,
      });
      return true;
    } catch {
      return false; // logged out / timeout / unexpected failure
    }
  },

  async resolveSessionRef(opts, account) {
    // The rollout is written at session start, but the TUI needs a moment. This
    // blocks session creation, so the wait is short and failure is recoverable.
    const deadline = Date.now() + 3_000;
    for (;;) {
      const ref = newestRolloutFor(account.config_dir, opts.worktreePath)?.id;
      if (ref !== undefined) return ref;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    // Placeholder: hasConversation() reports it missing, so resume recovers the
    // real ref through discoverSessionRef rather than failing outright.
    return opts.sessionId;
  },

  discoverSessionRef(worktreePath, account) {
    return newestRolloutFor(account.config_dir, worktreePath)?.id ?? null;
  },

  hasConversation(ref, account) {
    return rolloutPath(account.config_dir, ref) !== null;
  },

  sessionActivityAt(ref, account) {
    const path = rolloutPath(account.config_dir, ref);
    if (path === null) return null;
    try {
      return statSync(path).mtime;
    } catch {
      return null;
    }
  },

  async exportTranscript(ref, account) {
    const path = rolloutPath(account.config_dir, ref);
    if (path === null) return '';
    return renderRollout(path);
  },

  /**
   * UNVERIFIED against a live session — codex requires a logged-in account to
   * reach its composer, so these come from strings in the 0.146.0 binary rather
   * than observed output: the busy footer carries "… to interrupt" and the idle
   * footer "? for shortcuts". Confirm with docs/acceptance/phase-7-agents.md and
   * correct here. Codex has no hook side-channel, so these are the ONLY status
   * driver for it (unlike claude-code, where they are a fallback).
   */
  statusPatterns: {
    waitingInput: [/\?\s+for shortcuts/i],
    busy: [/to interrupt/i],
    limitReached: [/you've (hit|reached) your usage limit/i],
  },
};

/** Absolute path of the rollout whose id is `ref`, or null. */
function rolloutPath(configDir: string, ref: string): string | null {
  for (const file of rolloutFiles(configDir)) {
    // The uuid is in the filename, so this needs no file reads in the common case.
    if (file.endsWith(`-${ref}.jsonl`)) return file;
  }
  return null;
}
