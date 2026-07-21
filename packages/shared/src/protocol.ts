/**
 * The communication-protocol version — NOT the app version (SPEC §6,
 * "Protocol versioning and compatibility").
 *
 * Same `major` ⇒ CLI/UI and daemon are compatible in both directions; a
 * `major` mismatch makes the CLI update the daemon automatically. Bump rules
 * live in PROTOCOL.md at this package's root — read it before changing any
 * schema in this package.
 */
// 6.0 (2026-07-15): major bumped with no schema shape change, on purpose —
// forces every connected daemon to hit a major mismatch on the next handshake
// and auto-upgrade onto this release (see PROTOCOL.md, "The rule").
// 6.1 (2026-07-15): additive — `Session.osc_title` (the terminal-title
// "sequence" name) and the `renamed` message's `osc_title` field, plus the
// profile setting `tabTitleTemplate` (a loose key).
// 6.2 (2026-07-15): additive — POST /api/sessions/:id/unarchive (archive is now
// a reversible hide, not a teardown), and the profile setting `restartTemplate`
// (a loose key) for the resume-after-restart launch text.
// 7.0 (2026-07-17): breaking — workspace ui_state re-keyed from (project,
// profile) to profile alone (the editor area is shared across projects):
// GET/PUT /api/projects/:id/state moved to /api/profiles/:id/state, with no
// cross-profile seeding.
// 7.1 (2026-07-18): additive — the profile setting `sessionDefaults` (a loose
// key): per-kind seed defaults for the new-session modal (base branch,
// separate branch, separate directory).
// 7.2 (2026-07-20): additive — tree entries carry an optional `symlink` flag,
// and a symlink's `type` now reports its resolved target kind (`dir`/`file`)
// so symlinked directories are explorable; `symlink` stays reserved for a
// broken or worktree-escaping link. Old clients ignore the field and already
// handle the `dir`/`file` values.
// 7.3 (2026-07-20): additive — the Scratchpad endpoint group
// (GET/POST/PATCH/DELETE /api/scratchpad): a per-profile bank of prompts/notes,
// each project- or profile-scoped, plus the loose `right_panel` ui_state key
// selecting the right sidebar's sessions/scratchpad view.
export const PROTOCOL_VERSION = { major: 7, minor: 3 } as const;
