/**
 * `sessions.osc_title` holds the terminal-title "sequence" name — the last title
 * the session's process set on its PTY via an OSC 0/1/2 escape, normalised by
 * the daemon (leading spinner/status glyphs stripped). It is the VSCode
 * `${sequence}` variable and a name source for agents and terminals that have no
 * adapter-maintained `agent_title` (SPEC §4). Nullable, NULL for existing rows —
 * a live session repopulates it the next time its process sets a title.
 */
export const migration012 = {
  version: 12,
  name: 'osc-title',
  sql: `
ALTER TABLE sessions ADD COLUMN osc_title TEXT;
`,
};
