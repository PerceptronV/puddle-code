import type { Account } from '@puddle/shared';

export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  message_count: number;
}

export interface SubscriptionUsageWindow {
  key: string;
  label: string;
  used_percentage: number;
  resets_at: string | null;
}

export interface LiveUsage {
  /** ISO timestamp of the most recent capture. */
  captured_at: string;
  /** Current conversation's context-window fill, 0..100, or null pre-turn. */
  context_used_percentage: number | null;
  /** Session cost in USD (≈0 for subscription accounts — unmetered). */
  total_cost_usd: number | null;
  model: string | null;
}

export interface LaunchOpts {
  worktreePath: string;
  /** Puddle session uuid (adapters with presetSessionId reuse it as the agent's id). */
  sessionId: string;
  /** First prompt, already including any onboarding preamble. */
  prompt?: string;
  skipPermissions: boolean;
}

export interface StatusPatterns {
  waitingInput: RegExp[];
  busy?: RegExp[];
  limitReached?: RegExp[];
}

/**
 * One adapter per coding agent (SPEC §5). ALL agent-specific behaviour —
 * flags, env vars, session-file locations, status regexes — lives in the
 * adapter; core session logic stays agent-agnostic.
 */
export interface AgentAdapter {
  id: string;
  displayName: string;
  /** Executable name resolved on PATH. */
  binary: string;
  capabilities: {
    resume: boolean;
    presetSessionId: boolean;
    skipPermissions: boolean;
    migratableSessions: boolean;
  };
  /** Config-dir isolation env for a puddle-managed account. */
  env(account: Account): Record<string, string>;
  /**
   * One-off seeding of a freshly created (empty) config dir, before any
   * login or session runs — e.g. marking the agent's first-run onboarding
   * complete so it never hijacks a puddle session with its setup wizard.
   */
  prepareConfigDir?(configDir: string): void;
  /**
   * Whether the account still holds the conversation `ref` resumes. Checked
   * before spawning a resume so a missing conversation is a clean 409, not
   * an agent process dying on launch.
   */
  hasConversation?(ref: string, account: Account): boolean;
  /**
   * Imports a pre-existing config dir by COPYING it into the puddle-owned
   * `configDir` (already created, empty) — the source is read once and never
   * touched again. Implementations also apply their prepareConfigDir seeding.
   */
  importConfigDir?(sourceDir: string, configDir: string): Promise<void>;
  /**
   * Asks the agent whether the account is currently authenticated (e.g. after
   * an import, where credentials may be keychain-bound and not travel with
   * the copied files). Never surfaces credential material — a boolean only.
   * Also consulted before create/resume: a stale logged-in flag otherwise
   * lets the agent's own login screen hijack the session (and its preset id).
   */
  checkLoggedIn?(account: Account): Promise<boolean>;
  /**
   * Recovers the conversation ref for a worktree when the recorded one
   * matches nothing (the agent restarted its session under a fresh id).
   * Returns the newest conversation whose recorded cwd is the worktree.
   */
  discoverSessionRef?(worktreePath: string, account: Account): string | null;
  /**
   * Token usage the agent recorded for this account, summed from its own
   * on-disk history. Best-effort and non-authoritative (not billing data);
   * null when the agent keeps no readable record.
   */
  usageStats?(account: Account): AgentUsage | null;
  /**
   * The most recent live-session usage the agent emitted (context-window
   * fill, cost). Credential-free; null when nothing has been captured yet.
   */
  liveUsage?(account: Account): LiveUsage | null;
  /**
   * Subscription rate-limit windows (the `/usage` view). Reads the account's
   * own OAuth token, so it runs ONLY for opted-in accounts (SPEC §2). Fails
   * safe to null (unreachable token, network error, unknown shape).
   */
  subscriptionUsage?(account: Account): Promise<SubscriptionUsageWindow[] | null>;
  /**
   * Idempotent config-dir upkeep run once per account at boot — brings older
   * accounts up to date with setup that newer versions seed at create time
   * (e.g. the live-usage status line). Must never overwrite user data.
   */
  reconcileConfigDir?(account: Account): void;
  launchArgs(opts: LaunchOpts): string[];
  resumeArgs(ref: string, opts: LaunchOpts): string[];
  loginArgs(): string[];
  /** Agent-native session ref: echoes a preset id or discovers it post-launch. */
  resolveSessionRef(opts: LaunchOpts, account: Account): Promise<string>;
  /** Matched against ANSI-stripped output (SPEC §5). */
  statusPatterns: StatusPatterns;
  /** Phase 7: move conversation state between accounts (same agent). */
  migrateSession?(ref: string, from: Account, to: Account, worktree: string): Promise<void>;
  /** Phase 7: render the conversation as text for cross-agent hand-off. */
  exportTranscript?(ref: string, account: Account, worktree: string): Promise<string>;
}
