/** Managed programme files remain referenced until their exact owner exits cleanly. */
export const migration034 = {
  version: 34,
  name: 'runtime-code-runs',
  sql: `
CREATE TABLE runtime_code_runs (
  runtime_id TEXT PRIMARY KEY REFERENCES runtime_bindings(runtime_id) ON DELETE CASCADE,
  directory TEXT NOT NULL UNIQUE
);
`,
};
