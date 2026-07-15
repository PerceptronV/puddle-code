/**
 * Shared contracts for the CLI library. Everything under `lib/` is written to
 * be embeddable — no `process.exit`, no direct console or TTY access — so a
 * future desktop shell (Electron/Tauri) can drive the same functions from a
 * main process (SPEC §10). Only `src/index.ts` and `src/cli/` touch the
 * process.
 */

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

/** A logger that drops everything — the lib default when none is injected. */
export const silentLogger: Logger = { info() {}, warn() {} };

/** Lifecycle events a running cockpit emits (tunnel drops, upgrades, …). */
export type CliEvent =
  | { t: 'tunnel-down' }
  | { t: 'tunnel-up' }
  | { t: 'upgrading'; from: string; to: string; liveSessions: number };

export type CliErrorCode =
  | 'ssh_unreachable'
  | 'daemon_unreachable'
  | 'daemon_start_timeout'
  | 'upgrade_failed'
  | 'cli_outdated'
  | 'port_in_use'
  | 'ambiguous_session'
  | 'unknown_session'
  | 'attach_needs_tty'
  | 'unsupported_platform'
  | 'not_installed'
  | 'token_rejected'
  | 'bad_arguments';

/** The lib's one error shape; the bin renders message + hint and exits 1. */
export class CliError extends Error {
  constructor(
    readonly code: CliErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
