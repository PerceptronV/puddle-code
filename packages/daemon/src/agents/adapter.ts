import type { Account } from '@puddle/shared';

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
   */
  checkLoggedIn?(account: Account): Promise<boolean>;
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
