/** One successor per positively fenced predecessor; preserved history is never replay authority. */
export const migration051 = {
  version: 51,
  name: 'huddle-recoveries',
  sql: `
CREATE TABLE huddle_recoveries (
  source_runtime_id TEXT PRIMARY KEY REFERENCES runtime_bindings(runtime_id),
  runtime_id TEXT NOT NULL UNIQUE REFERENCES runtime_bindings(runtime_id)
);
`,
};
