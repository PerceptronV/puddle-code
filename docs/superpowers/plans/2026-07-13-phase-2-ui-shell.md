# Puddle Phase 2 — UI shell: implementation plan

> **For the executing agent:** this plan is self-contained. Read `SPEC.md` §11 (profiles/settings/reload semantics), §12 (design system — normative), §14 Phase 2 (acceptance tests), and `CLAUDE.md` (conventions: British English, tokens.css as single colour source, changelog discipline) before starting.

## Context

Phases 0–1 are complete and committed (see `docs/superpowers/plans/2026-07-13-phase-0-1-daemon-core.md` and `docs/acceptance/phase-1.md`; CI green, 77 tests). The daemon (`packages/daemon`) fully implements: profiles/accounts/repos/projects/sessions REST CRUD, bearer-token + Host/Origin security, the server-side permissions gate, the claude-code adapter (flags verified against 2.1.207), worktree lifecycle with onboarding, PTY spawning, WS streaming with log replay, and the boot reconcile pass. `packages/web` is a placeholder SPA; Phase 2 replaces it with the real cockpit shell per SPEC §14:

> **Phase 2 — UI shell.** Design system foundation first (tokens.css with both themes + registry, CI token/contrast check, Tailwind + shadcn setup, fonts, runtime-generated xterm/Monaco themes — §12), then: project dashboard; project workspace with session tabs and live status ripples; terminal attach with replay; new-session modal (account → base branch → title/prompt); interrupted-session resume button; theme switcher; settings panel (all §11 sections; permissions gate with its confirm dialogue); ui_state persistence and restore-on-open.

## Current state a fresh agent must know

- **Monorepo**: pnpm 11 (`corepack`), TypeScript ~5.9 strict + project references, eslint 10 flat config, prettier, vitest 4 (`projects: ['packages/*']` in root `vitest.config.ts`; each package may carry its own `vitest.config.ts` — the daemon's aliases `@puddle/shared` → shared *source*).
- **`packages/shared`** — every API/WS shape as zod v4 schemas (`z.iso.datetime()`, `z.uuid()`, `z.looseObject` are the v4 spellings). Import types from here; never define shapes locally.
- **Daemon API implemented** (all under bearer auth; see `packages/daemon/src/http/routes/`): `/api/version`, `/api/profiles` (+`/:id/settings` GET/PATCH), `/api/accounts` (+`/:id/login` → spawns a login PTY on stream `login-<id>`), `/api/repos` (+PATCH, +`/:id/fetch`; GET includes `orphan_worktrees`), `/api/projects` (+`/:id` detail with sessions, +`/:id/archive`), `/api/sessions` (+create/resume/kill/archive/PATCH-title), `/api/config`.
- **WS protocol implemented** (`packages/daemon/src/ws/gateway.ts`): first message MUST be `{t:'auth', token}`; then `attach` (server replies `replay` with the log tail, then live `output`), `stdin`, `resize`, `detach`, `spawn-shell` → `shell-spawned`, `subscribe-status` → `status` broadcasts `{session, status, last_activity_at}`. Message schemas: `packages/shared/src/ws/messages.ts`.
- **Session statuses**: `starting | running | waiting_input | exited | interrupted | archived`; `worktree_missing` is a computed boolean on session reads.
- **Dev workflow**: `pnpm dev` runs daemon tsc-watch + vite with `/api` and `/ws` proxied to `127.0.0.1:7433` (`packages/web/vite.config.ts`). `pnpm build` embeds `web/dist` into `daemon/dist/public`. Daemon token lives at `$PUDDLE_HOME/token`.
- **Gotchas already solved — do not regress**: node-pty's exec-bit postinstall fix (`scripts/fix-node-pty-perms.mjs`); `@hono/node-ws` is deprecated (WS is built into `@hono/node-server` v2); package `typecheck` scripts must be `tsc -b` (not `--noEmit`, composite refs).

## Decisions locked for this phase (user-confirmed)

1. **Fonts**: **Ubuntu Sans** (UI) + **Ubuntu Sans Mono** (mono), self-hosted woff2 variable fonts. Licence is the **Ubuntu Font Licence 1.0** (not OFL) — ship the licence text next to the font files (`packages/web/src/assets/fonts/LICENCE-ubuntu-font-licence-1.0.txt`); UFL permits redistribution with the licence included. No font CDNs (SPEC §12).
2. **Editor tabs defer to Phase 3.** The `ui_state` snapshot schema includes `editor_tabs` from day one (so Phase 3 needs no schema change), but Phase 2 renders no editor pane and the Phase 2 AT drops the editor-tab clause. Monaco is NOT installed in Phase 2; the runtime **Monaco theme generator is still written and unit-tested** (pure function: tokens → `monaco.editor.IStandaloneThemeData`-shaped data, no monaco import) so Phase 3 plugs it in and the theme-switch AT extends to the editor then.
3. **Data layer**: TanStack Query v5 for REST (queries + invalidation) plus one singleton WS manager (auto-reconnect with backoff, re-auth, re-attach, listener registry). No zustand/redux — server state lives in Query, live terminal/status data flows through the WS manager, transient UI state in React.
4. **No Playwright in Phase 2.** Unit-test the pure logic (theme generation, token contrast checker, ui-state serialisation, WS manager reducer); the workspace ATs are a manual script in `docs/acceptance/phase-2.md` (same pattern as phase-1).

## Workstream A — daemon additions (small, do first)

New endpoints Phase 2 consumes; follow the existing route-factory + store patterns.

1. **`project_states` endpoints** (table already exists in migration 001):
   - Shared schemas in `packages/shared/src/api/project-state.ts`: `uiStateSnapshotSchema` = `z.looseObject({ session_tabs: z.array(sessionId).default([]), active_session: sessionId.nullable().default(null), editor_tabs: z.array(z.object({ session: sessionId, path: z.string() })).default([]), layout: z.looseObject({}).default({}), explorer_pin: sessionId.nullable().default(null) })` (loose so later phases extend without migrations), plus `projectStateResponseSchema = { ui_state: uiStateSnapshotSchema, updated_at: isoTimestamp }`.
   - `db/stores/project-states.ts`: `get(projectId, clientId)`, `latest(projectId)`, `put(projectId, clientId, uiState)` (upsert), `gc(retentionDays)`.
   - Routes on the projects router: `GET /api/projects/:id/state?client=<uuid>` — client's row, falling back to the project's most recent snapshot, 404 code `no_state` when neither exists; `PUT` — body `{ui_state}`, validates, upserts, returns stored row.
   - **GC**: add `uiStateRetentionDays` (default 90, min 1) to `daemonConfigSchema`; run `gc()` once at boot in `daemon.ts`.
2. **Daemon tests**: extend the e2e suite — PUT state as client A, GET as client A (own row), GET as client B (falls back to A's snapshot), PUT as B doesn't clobber A.

## Workstream B — design-system foundation (before any feature UI)

All in `packages/web`. New deps: `tailwindcss` v4 + `@tailwindcss/vite`, shadcn/ui (CLI-generated into `src/components/ui/` — owned code, restyle freely), `lucide-react`, `cmdk`, `sonner`, `react-resizable-panels`, `@xterm/xterm` + `@xterm/addon-fit`, `react-router` (v7, library mode), `@tanstack/react-query`.

1. **`src/styles/tokens.css`** — the two-layer architecture, verbatim from SPEC §12: `:root` primitives (the five core colours + every extended ramp hex listed in §12), then `[data-theme='dark']` and `[data-theme='light']` blocks each assigning **all** semantic tokens: `--bg-base/-surface/-elevated`, `--border`, `--text-primary/-secondary/-muted`, `--accent`, `--accent-hover`, `--focus-ring`, `--danger`, `--status-running/-waiting/-interrupted/-idle`, `--selection`, and the 16 `--ansi-*` colours per the §12 ANSI mapping rule (dark = pastel depth, light = deep step, brights one lightness step up). Components use semantic tokens only — no hex anywhere else (CLAUDE.md rule).
2. **Tailwind v4 theme** (`src/styles/app.css`): `@theme` maps utility colours onto the semantic variables (e.g. `--color-surface: var(--bg-surface)`), plus the two font stacks and a type scale. Density defaults per §12 (compact paddings, `font-variant-numeric: tabular-nums` for counts/ports).
3. **Fonts**: `src/assets/fonts/` with the two variable woff2 files + UFL licence text; `src/styles/fonts.css` `@font-face` (`font-display: swap`). Mono is the identity face: session titles, branches, paths, statuses.
4. **Theme registry + runtime generation** (`src/lib/theme.ts`):
   - `THEMES = ['dark', 'light'] as const` + `'system'` preference resolved via `prefers-color-scheme` (with change listener).
   - `applyTheme(name)`: sets `data-theme` on `<html>`, persists to localStorage, notifies subscribers.
   - `xtermThemeFromCss(): ITheme` and `monacoThemeFromCss()` — pure functions reading `getComputedStyle(document.documentElement)`; every open terminal updates `term.options.theme` on theme change (Monaco consumer arrives Phase 3). **Adding a theme = one CSS block + one registry entry, zero component changes.**
5. **CI token/contrast check** (`packages/web/scripts/check-tokens.mjs`): parses `tokens.css`, asserts each theme block defines the complete semantic set, computes WCAG contrast — `--text-primary`/`--text-secondary` ≥ 4.5:1 and `--text-muted`, `--accent`, all four `--status-*` ≥ 3:1 against each of `--bg-base/-surface/-elevated`. Wire as a `check-tokens` script, add to the root `lint` chain and CI. Unit-test the contrast maths in vitest; if a §12 hex fails a pair, adjust the *assignment* (not the ramp) and note it in the commit.
6. **shadcn setup**: Tailwind v4-compatible init; generate only what Phase 2 uses (button, dialog, dropdown-menu, input, label, select, switch, tabs, tooltip, command via cmdk, sonner toaster); restyle all of them onto semantic tokens immediately — a stock-shadcn-looking control is a defect (SPEC §12 quality floor).

## Workstream C — app shell: auth, identity, data, routing

`packages/web/src/`:

1. **Token bootstrap** (`lib/auth.ts`): on load, read `#token=…` fragment → `history.replaceState` to strip it → localStorage. No token → full-screen instruction card (run `puddle start`, or paste the token from `~/.puddle/token` — input field stores it). 401 responses clear the stored token and return to this screen.
2. **Client identity** (`lib/client-id.ts`): stable uuid in localStorage (`crypto.randomUUID()` once).
3. **API client** (`lib/api.ts`): thin typed `fetch` wrapper adding the bearer header, parsing the shared error envelope into a typed `ApiError`; TanStack Query hooks per resource (`useProfiles`, `useProjects(profileId)`, `useProjectDetail(id)`, `useSessions(projectId)`, `useAccounts(profileId)`, `useRepos`, `useConfig`, mutations for create/resume/kill/archive/settings-patch). Import all types from `@puddle/shared`.
4. **WS manager** (`lib/ws.ts`): singleton; connects to `/ws`, sends `{t:'auth'}` first, exponential-backoff reconnect (re-auth + re-`attach` all registered terminals + re-`subscribe-status` after reconnect); API: `attach(session, term, {cols, rows, onData(replay|output), onExit})`, `detach`, `write`, `resize`, `spawnShell(session): Promise<term>`, `onStatus(listener)`. Status events also invalidate/patch the relevant Query caches so sidebar and dashboard stay live.
5. **Profile picker** (`features/profile/ProfilePicker.tsx`): first-load create-or-select (SPEC §11), remembered in localStorage; switcher accessible from the top bar and ⌘K.
6. **Routing**: `/` dashboard, `/project/:id` workspace, `/project/:id/session/:sid` (deep-link selects the session tab; `/diff|/history` sub-routes are Phase 3 — leave the route structure ready). A window binds to one project (SPEC §6).
7. **⌘K palette** (`features/palette/`): cmdk with a small command-registry module so later phases append commands. Phase 2 commands: switch project, switch session, new session, switch theme, open settings.

## Workstream D — dashboard + project workspace

1. **Dashboard `/`** (`features/dashboard/`): current profile's projects as cards (name, repo path, session counts by status with status-dot colours, owning profile shown — plus the "everyone" toggle listing all profiles' projects, read-only view); new-project flow (pick/register repo by absolute path → name); empty state per §12 ("No projects yet — press ⌘K…").
2. **Workspace `/project/:id`** (`features/workspace/`): `react-resizable-panels` layout — left sidebar (session list) + main terminal area. Session sidebar rows: mono title, branch, **status ripple** (`features/status/StatusDot.tsx`: CSS-only concentric ripple in `--status-running` while running, pulsing `--status-waiting` when waiting, static for the rest; `prefers-reduced-motion` → static dot — this is the interface's one animated flourish), `waiting_input` also mirrored in `document.title`. Live via `subscribe-status`.
3. **Terminal** (`features/terminal/Terminal.tsx`): xterm.js + fit addon, theme from `xtermThemeFromCss()` and re-applied on theme change; attach via the WS manager (replay renders verbatim, then live output); `resize` on container resize (fit → `{t:'resize'}`); scrollback size from client settings. One terminal per session tab (`agent` term only — shell tabs are Phase 8).
4. **New-session modal**: account (this profile's, with `logged_in` badge; "add account" links to settings) → base branch (default from repo) → title/prompt; per-session skip toggle rendered **only** when the profile gate is on AND the chosen account opted in; on 400 `skip_permissions_denied` show the server's message. On create: optimistic tab + attach.
5. **Session lifecycle UI**: `interrupted` rows get a one-click Resume button (also an inline banner in the terminal pane); kill and archive actions with confirm dialogs; archive surfaces the `worktree_dirty` 409 as a "discard changes?" force-confirm; `worktree_missing` badge (archive-only); sessions running with prompts skipped are badged (SPEC §11).

## Workstream E — settings panel

`features/settings/` — a dialog (route-addressable `#settings/<section>`), sections per SPEC §11:

- **Appearance**: theme (dark/light/system), UI & terminal font size, density, reduced motion — client scope (localStorage via a `useClientSettings` hook).
- **Profile**: name (read-only in v1), branch prefix, default account & agent → PATCH `/api/profiles/:id/settings`.
- **Accounts**: per agent type: list with login state; add (POST then immediately open a terminal dialog attached to the returned `login-<id>` stream — reuses the Terminal component); per-account skip toggle **visible only when the gate is on**.
- **Permissions & safety**: the `allowSkipPermissions` gate switch; enabling opens the §11 warning dialogue that spells out what a prompt-free agent can do and **requires typing the profile name** to confirm; disabling is immediate and hides all skip toggles.
- **Notifications**: preference storage only (desktop/sound on waiting_input, per-project mute) — actual notifications are Phase 8; store the shape now so Phase 8 is read-only work here.
- **Terminal & editor**: scrollback, tab size, word wrap (client scope; editor keys consumed in Phase 3).
- **Repositories**: per repo: default base branch, fetch toggle, **onboarding notes** (plain textarea, PATCH), last-fetched time, manual "fetch now", orphan-worktree list (display + "never auto-deleted" copy).
- **Host**: daemon scope via `/api/config` (port with "applies on restart" note, `fetchIntervalMinutes`, log caps, `autoResume`, `uiStateRetentionDays`) — marked "affects all profiles".

## Workstream F — ui_state persistence and restore

1. `features/workspace/use-ui-state.ts`: composes the snapshot (`session_tabs` order, `active_session`, `layout` panel sizes, `editor_tabs` always `[]` in Phase 2, `explorer_pin` null) and PUTs it **debounced ~2 s** after any change; on project open, GET (client row → fallback latest) and restore: reopen session tabs in order, reattach terminals (replay makes them look untouched), restore panel sizes, select `active_session`, surface interrupted sessions with resume buttons. Transient focus stays local (SPEC §11).
2. Unit-test snapshot serialisation round-trip and the debounce; the restore AT is manual.

## Acceptance tests (write docs/acceptance/phase-2.md, same style as phase-1)

Adjusted per the editor-tabs deferral decision:

1. Open a project with three sessions, reorder tabs, resize panes; kill the browser; reopen `/project/:id` → identical workspace (tab order, active session, pane sizes, terminals replayed). Repeat from a second browser profile → seeds from the snapshot but its changes never clobber the first client's row.
2. Switching theme (⌘K and settings) restyles chrome AND terminal together with no reload; ANSI colours visibly share the palette. (Monaco joins this AT in Phase 3.)
3. `pnpm --filter @puddle/web check-tokens` fails if a semantic token is deleted from one theme block or a contrast pair is broken (verify by temporarily breaking one).
4. Permissions gate: enabling requires typing the profile name; only then do account skip toggles appear; the new-session skip toggle appears only for opted-in accounts; a 400 from the daemon renders its message.
5. Account login: adding an account opens the login terminal in-app; on completion the account shows logged-in.
6. Interrupted sessions (restart the daemon) show resume buttons; one click resumes and the terminal replays + continues.
7. Status ripple: running sessions ripple green, waiting pulses amber; `prefers-reduced-motion` shows static dots; tab title reflects waiting sessions.

## Housekeeping (same commits as the work)

- `CHANGELOG.md` under `[Unreleased]` per change; update CLAUDE.md's repo-map web bullet to describe the real structure once it exists; commits in British English ending with the Claude co-author line.
- CI: add the check-tokens step; keep `pnpm build` embedding assertion green (web build must stay embeddable — no runtime-only assets outside `dist`).

## Verification

- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all green; CI workflow passes.
- Manual: `pnpm build && PUDDLE_HOME=$(mktemp -d) node packages/daemon/dist/index.js`, open `http://127.0.0.1:7433/#token=$(cat $PUDDLE_HOME/token)` — walk `docs/acceptance/phase-2.md` end to end with a real repo and (if logged in) a real claude-code session; use the fake-adapter e2e flow otherwise.
- Suggested execution order = workstreams A → B → C → D → E → F, committing per workstream; B must be complete before any feature UI lands (SPEC §14: "design system foundation first").
