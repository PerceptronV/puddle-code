/** One explicit user disposition per exact admitted operation; never store reply text in the audit. */
export const migration040 = {
  version: 40,
  name: 'programme-outcome-dispositions',
  sql: `
CREATE TABLE puddlang_outcome_dispositions (
  run_id TEXT NOT NULL,
  operation_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('read', 'discard')),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled', 'interrupted')),
  disposed_at TEXT NOT NULL,
  PRIMARY KEY (run_id, operation_id),
  FOREIGN KEY (run_id, operation_id) REFERENCES puddlang_runtime_turns(run_id, operation_id) ON DELETE CASCADE
);
`,
};
