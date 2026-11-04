/** One replaceable attention condition and durable delivery claim per owner. */
export const migration038 = {
  version: 38,
  name: 'runtime-attention',
  sql: `
CREATE TABLE runtime_attention (
  runtime_id TEXT PRIMARY KEY REFERENCES runtime_bindings(runtime_id) ON DELETE CASCADE,
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  session_id TEXT REFERENCES sessions(id),
  event_id TEXT,
  attention TEXT,
  delivered_id TEXT
);
`,
};
