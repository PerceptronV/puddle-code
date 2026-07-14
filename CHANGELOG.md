<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Changed
- Ports never surface in the UI: the port row leaves the Host settings (set it via `--port` on the daemon or `config.json`), and the new top-bar centre shows an scp-style location instead — `user@host`, plus `:repo-path` (`~`-compressed) once a workspace is open, backed by `GET /api/host`.
- Secondary hints sit on their own line and start lowercase; light-theme muted text switches from golden bark to a deeper altitude blue (`#4A86E8`, AA-checked); fields rest at their former hover fill so they read as clickable on any surface; the settings nav is 1.5× larger.
- Project ids are 10-hex-char handles (`/project/a1b2c3d4e5`) instead of integers; migration 002 rebuilds the affected tables and remaps existing rows.
- The base-branch field in the new-session modal autocompletes from the repo's branches (new `GET /api/repos/:id/branches`: local + fetched remote heads, default base first) via a shared hint-input component that the repository-path field also uses.
- The dashboard is just the project grid: the "everyone" cross-profile view, the heading, and the header button are gone — projects are strictly per-profile, and creation lives in ⌘K plus the empty state.
- The new-project flow is one path field with live directory autocomplete from the daemon host (`GET /api/fs/dirs`, dotdirs included, git repos flagged, keyboard-navigable); paths matching a registered repository reuse it, and the project name prefills from the directory. `~` paths expand on the host for both hints and registration, and re-registering a known path returns the existing repo instead of a 409.
- Menu highlights (dropdowns, selects, ⌘K) use the ink action fill instead of accent blue, and text fields no longer show a focus outline — the fill shift is the cue; both live in shared recipes (`components/ui/recipes.ts`) so every component inherits them.
- Primary actions (buttons, checked toggles) are ink rather than accent blue: new `--action`/`--action-hover`/`--action-ink` semantic tokens — mist on dark, storm navy on light — with the accent reserved for links, focus, and selection; the fill/ink pairing joins the contrast check.
- Light theme is now a white ground (was khaki paper); the dark storm-navy theme is unchanged and SPEC §12's table is updated to match.
- The theme preference defaults to following the OS (`system`) instead of dark.
- UI restyled to the `HUMANS.md` design brief: borderless components with fill-shift hover/active feedback, pointer cursors on everything interactive, boxless token and profile start screens, and floating layers separated by shadow rather than outline. `CLAUDE.md` now tells every agent to read `HUMANS.md` first.
- The web bundle is code-split: dashboard, workspace, settings, and the xterm terminal each load as their own chunk.

### Added
- Initial scaffold: monorepo (shared / daemon / web / cli), CI, SPEC.md, CLAUDE.md, changelog conventions.
- Daemon core (Phase 1): profiles/accounts/repos/projects/sessions REST API with zod-validated shapes from `@puddle/shared`; SQLite schema and migration runner; append-only per-terminal PTY logs with tail replay.
- Local security layer: mandatory bearer token (`~/.puddle/token`, 0600), Host/Origin validation against DNS rebinding and cross-site requests; WS authenticates via a first `auth` message.
- Permission-prompt gate enforced server-side: `skip_permissions` needs the profile gate plus the account opt-in (400 otherwise) and is re-evaluated on every resume with a silent downgrade noted in the terminal.
- claude-code adapter (flags verified against Claude Code 2.1.207): `CLAUDE_CONFIG_DIR` isolation, preset `--session-id`, `--resume`, `auth login` flow, TUI status patterns.
- Worktree manager: per-repo mutex, create-time/open-time/periodic fetch policy, `origin/<base>` resolution, branch-collision suffixing, clean-or-force removal keeping the branch, orphan-worktree detection.
- Agent-driven worktree onboarding: preamble built from `repos.onboarding_notes` injected into every fresh worktree; `.puddle/onboarding-notes.md` syncs rules back with the previous notes kept in the events audit trail.
- WebSocket terminal streaming: multi-viewer attach with log replay, stdin, resize (last-writer-wins), shell tabs (`spawn-shell`), live status broadcasts.
- Boot reconcile pass: sessions found without a live PTY become `interrupted`, resumable in place with an injected interruption note; optional `autoResume`.
- Account login PTYs (`login-<id>` streams) marking accounts logged in on clean exit.
- Phase 1 acceptance script (`docs/acceptance/phase-1.md`) and a full end-to-end test suite with a deterministic fake agent.
- Design-system foundation (SPEC §12): two-layer `tokens.css` (primitive ramps + dark/light semantic themes incl. the 16 ANSI colours), Tailwind v4 theme mapped onto semantic tokens, self-hosted Ubuntu Sans / Ubuntu Sans Mono variable fonts (UFL 1.0 licence shipped alongside), runtime-generated xterm and Monaco themes, owned restyled UI primitives, and a `check-tokens` CI guard asserting theme completeness and WCAG AA contrast.
- Web app shell: token bootstrap from the `#token=` fragment (stripped from the URL, stored per browser, 401 returns to the gate), profile picker, project routing, TanStack Query data layer, a single reconnecting WebSocket manager that re-authenticates and re-attaches terminals, live status cache sync, and the ⌘K command palette (switch project/session, new project/session, theme, settings).
- Project dashboard and workspace: project cards with live per-status session counts and an "everyone" view; resizable sidebar + terminal layout; session rows with status ripples (reduced-motion aware), skip-permissions and missing-worktree badges; xterm terminals with replay, resize, and theme regeneration; new-session modal with a gate-aware skip toggle; resume banners for interrupted sessions; kill/archive confirmations incl. the dirty-worktree force path; waiting sessions mirrored in the tab title.
- Settings panel with every §11 section: Appearance (theme, font sizes, density, reduced motion — per browser), Profile (branch prefix, default account), Accounts (add + in-app login terminal, per-account skip opt-in shown only behind the gate), Permissions & safety (the gate switch with its typed-profile-name warning dialogue), Notifications (preference storage for Phase 8), Terminal & editor, Repositories (base branch, fetch policy, onboarding notes, orphan worktrees), and Host (daemon config).
- New daemon endpoints backing the settings panel: `PATCH /api/profiles/:id` (branch prefix), `PATCH /api/accounts/:id` (skip-permissions opt-in), `GET /api/agents` (registered adapters with capabilities); recorded in SPEC §6.
- Workspace snapshot persistence: `GET`/`PUT /api/projects/:id/state?profile=<id>` stores per-(project, profile) ui state — layout follows identity, so any browser, machine, or tunnel port restores the same workspace once the profile is picked (migration 003 re-keys existing rows to the project's owning profile); newcomers seed from the project's most recent snapshot; stale rows are garbage-collected at boot after `uiStateRetentionDays` (config, default 90).
- Restore-on-open: tab order (drag-reorderable strip), active session, and pane sizes persist per client with a 2 s debounced write and restore exactly on reopening the project; terminals repaint from the log-tail replay.
- Profiles and accounts are deletable: `DELETE /api/profiles/:id` and `DELETE /api/accounts/:id` (409 while non-archived sessions exist; cascades rows and removes credential directories), with confirm dialogues in settings — profile deletion requires typing the profile name.
- Phase 2 acceptance script (`docs/acceptance/phase-2.md`).
