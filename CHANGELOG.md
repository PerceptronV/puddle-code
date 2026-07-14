<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

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
- Web app shell: token bootstrap from the `#token=` fragment (stripped from the URL, stored per browser, 401 returns to the gate), profile picker, project routing, TanStack Query data layer, a single reconnecting WebSocket manager that re-authenticates and re-attaches terminals, live status cache sync, and the ⌘K command palette (switch project/session, new session, theme, settings).
- Project dashboard and workspace: project cards with live per-status session counts and an "everyone" view; resizable sidebar + terminal layout; session rows with status ripples (reduced-motion aware), skip-permissions and missing-worktree badges; xterm terminals with replay, resize, and theme regeneration; new-session modal with a gate-aware skip toggle; resume banners for interrupted sessions; kill/archive confirmations incl. the dirty-worktree force path; waiting sessions mirrored in the tab title.
- Settings panel with every §11 section: Appearance (theme, font sizes, density, reduced motion — per browser), Profile (branch prefix, default account), Accounts (add + in-app login terminal, per-account skip opt-in shown only behind the gate), Permissions & safety (the gate switch with its typed-profile-name warning dialogue), Notifications (preference storage for Phase 8), Terminal & editor, Repositories (base branch, fetch policy, onboarding notes, orphan worktrees), and Host (daemon config).
- New daemon endpoints backing the settings panel: `PATCH /api/profiles/:id` (branch prefix), `PATCH /api/accounts/:id` (skip-permissions opt-in), `GET /api/agents` (registered adapters with capabilities); recorded in SPEC §6.
- Workspace snapshot persistence: `GET`/`PUT /api/projects/:id/state?client=<uuid>` stores per-(project, client) ui state; new clients seed from the project's most recent snapshot; stale rows are garbage-collected at boot after `uiStateRetentionDays` (config, default 90).
