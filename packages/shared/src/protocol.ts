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
// 7.4 (2026-07-20): additive — a profile carries an optional `icon` (lucide
// name) and `icon_colour` (theme-colour key); both settable via PATCH
// /api/profiles/:id. Old clients ignore the fields and render the default glyph.
// 7.5 (2026-07-20): additive — the `home` PTY stream (a project-less shell in
// the daemon host's home directory; `spawn-shell` on it reuses the live shell)
// and the `kill-shell` client message (terminate a shell term, never the agent).
// 7.6 (2026-07-21): additive — the profile setting `hotkeys` (a loose key):
// per-profile keyboard-shortcut overrides (action-id → binding string).
// 8.0 (2026-07-21): major bump with NO schema change, on purpose — forces every
// connected daemon to hit a major mismatch on the next handshake and auto-upgrade
// onto this build (see PROTOCOL.md "The rule"; mirrors the 6.0 bump). Rolls up the
// additive 7.x features whose daemon-side code an older 7.x install still lacks.
// 9.0 (2026-07-24): captured session environment (SPEC §4). Additive surface —
// GET/DELETE /api/sessions/:id/env (captured var names + byte sizes, never
// values) and the profile setting `captureSessionEnv` (a loose key, default
// true) — but bumped major by decision: the release also changes daemon-side
// PTY behaviour (shell hook injection, OSC 7733 stripping), so every connected
// daemon must auto-upgrade onto this build rather than sit on 8.x.
// 9.1 (2026-07-24): additive — editor tab refs carry an optional `view`
// ('source' | 'preview') so a markdown/HTML tab's rendered-preview mode
// persists in `ui_state.layout_tree` (SPEC §8). Old clients/daemons ignore or
// round-trip the field (the snapshot is a loose object).
// 9.2 (2026-07-27): additive — config.json gains `displayName` (a user-chosen
// host label, editable in Settings → Host) and GET /api/host reports it as an
// optional `displayName` the UI prefers over the OS hostname; the upload route
// (POST /api/worktrees/:sid/upload) now honours relative paths in multipart
// filenames, creating intermediate directories, so folder drag-and-drop works
// (old daemons flatten to basenames — the UI feature-detects via this minor).
// Also in 9.2: the retired `ui_state.right_panel` key (the Scratchpad left the
// right sidebar for a top-bar popover) went optional-without-default, so the
// daemon stops injecting `'sessions'` into every stored snapshot; peers in
// both directions tolerate its presence and absence.
// 9.3 (2026-07-28): additive behaviour — POST /api/sessions/:id/archive now
// accepts a LIVE session (the daemon kills it as part of archiving) and is
// idempotent on an archived one, instead of 409ing `session_live`. No shape
// change; a newer UI on a 9.2 daemon degrades to the old conflict toast.
// 9.4 (2026-07-28): additive — POST /agent-signal (outside /api: nonce-gated,
// no bearer), the agent-hook status side-channel. The daemon injects
// PUDDLE_AGENT_SIGNAL_URL/_NONCE into agent PTYs; hook processes report
// working/waiting_input, which overrides the regex detector once seen.
// 10.0 (2026-07-28): major bump with NO further schema change, on purpose —
// forces every connected daemon to auto-upgrade at the next handshake (see
// PROTOCOL.md "The rule"; mirrors the 6.0/8.0 bumps). This release changes
// daemon-side behaviour the UI silently depends on — hook-driven status
// detection (a 9.x daemon leaves sessions stuck green) and archive killing
// live sessions — so no daemon may sit on 9.x. Ships the unreleased 9.3/9.4
// additions above.
// 10.1 (2026-07-28): additive — optional computed `stale_running` on the
// session shape: a `running` agent whose transcript has been quiet for over
// an hour, advisory only (the UI hints, the daemon never intervenes).
// 10.2 (2026-07-31): additive — the read-only worktree routes (GET tree /
// file / media / download) accept an optional absolute `?root=` override for
// the explorer's parent-directory browsing (mutations and PUT never do), and
// `editorTabRefSchema` gains the matching optional `root` + `external` kind.
// 10.3 (2026-07-31): additive — profile-scoped untitled drafts (SPEC §8):
// POST/GET/PUT/DELETE /api/profiles/:id/untitled[/:name], plus the `untitled`
// editor-tab kind whose `session` is the nil uuid (worktree-agnostic).
export const PROTOCOL_VERSION = { major: 10, minor: 3 } as const;
