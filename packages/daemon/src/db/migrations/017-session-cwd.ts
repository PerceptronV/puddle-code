/**
 * The directory a TERMINAL session's shell starts in, relative to its worktree
 * (SPEC §4, §8) — the file tree's "Open Terminal in Directory".
 *
 * Persisted rather than applied once at spawn: a session resumed after a daemon
 * restart has to come back where it was, or the directory it was opened in is
 * silently lost. Relative to `worktree_path` so the two cannot drift apart.
 * NULL — the default for every existing row — means the worktree root, which is
 * the behaviour every session had before this column existed. Plain additive
 * column, so no table rebuild.
 */
export const migration017 = {
  version: 17,
  name: 'session-cwd',
  sql: `
ALTER TABLE sessions ADD COLUMN cwd TEXT;
`,
};
