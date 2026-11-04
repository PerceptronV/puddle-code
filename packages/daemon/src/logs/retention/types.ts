export interface LogRetentionLimits {
  entries: number;
  files: number;
  copyBytes: number;
  milliseconds: number;
}
export const LOG_RETENTION_LIMITS: Readonly<LogRetentionLimits> = Object.freeze({
  entries: 256,
  files: 8,
  copyBytes: 2 * 1024 * 1024,
  milliseconds: 1000,
});

export interface LogRetentionOptions {
  logsDir: string;
  retentionDays: number;
  /** Retain exactly the full replay tail, including a partial UTF-8 prefix. */
  replayBytes: number;
  /** Synchronous: the final check and rename run in one event-loop turn. */
  isBusy(stream: string, term: string): boolean;
  now?: number;
  stopped?: () => boolean;
  /** An existing maintenance deadline, measured with performance.now(). */
  deadline?: number;
  /** Smaller isolated-test or caller budgets; cannot exceed the production ceilings. */
  limits?: Partial<LogRetentionLimits>;
}

export interface LogRetentionResult {
  compacted: number;
  reclaimedBytes: number;
  skipped: number;
  failed: number;
  /** False means another bounded slice can continue this traversal. */
  complete: boolean;
}

export function emptyRetentionResult(complete = true): LogRetentionResult {
  return { compacted: 0, reclaimedBytes: 0, skipped: 0, failed: 0, complete };
}
