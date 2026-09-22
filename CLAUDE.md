# CLAUDE.md — puddle

Puddle is a self-hosted orchestrator for CLI coding agents with first-class SSH support: a persistent daemon (`puddled`) runs on whatever machine hosts the work — your own laptop (`puddle launch`) or a remote box (`puddle launch user@host`) — and owns agent PTYs, git worktrees, and session state; a web UI provides project workspaces with terminals, editing, diffs, git history, and port forwarding. The full design is in `SPEC.md` — read it before making architectural changes.

**Read `HUMANS.md` at the start of every session.** It is the human-authored design brief for the UI's feel (minimalism, transparency, no boxes/borders, hover responsiveness) and it overrides SPEC §12 and any framework default wherever they conflict. Any UI work that ignores it is wrong by definition.

## Repo map

```
packages/
├── shared/    # the protocol package: zod schemas for REST + WS messages (the single source of
│              # truth for API shapes) + PROTOCOL_VERSION — read its PROTOCOL.md before schema changes
├── daemon/    # puddled: Hono HTTP/WS server, PTY manager, worktree manager, SQLite
│   ├── src/security/     # private host control, monotonic connection leases and resource revocation
│   ├── src/agents/       # adapters own flags, cached native catalogue discovery, and exact lifecycle integration
│   ├── src/compilation/  # provider-neutral compile modes, scheduling, dependency observation, and artefacts
│   ├── src/latex/        # local TeX discovery/recipes, managed outputs, and inverse SyncTeX
│   ├── src/sessions/     # immutable placement service + stable live runtimes + watched conversation catalogue
│   └── src/worktrees/    # worktree lifecycle plus repository-aware Git inspection/mutations
├── web/       # React UI: Tailwind v4 + owned shadcn-style components (src/components/ui/)
│   ├── src/styles/tokens.css   # THE colour source; scripts/check-tokens.mjs guards it in lint/CI
│   ├── src/lib/       # browser authorisation, TanStack Query hooks, singleton WS manager, theme registry
│   ├── src/features/  # dashboard, workspace (sidebar/tabs/xterm), editor/explorer/changes/search/worktrees
│                      # (Monaco tabs + drafts + dirty-diff gutter, file tree + transfer, repository-aware
│                      #  source control + commit-graph SVG, filename+content search), scratchpad + layouts (top-bar
│                      #  popovers), settings, ⌘K palette
│   └── src/features/remote/ + mobile/ # remote account/pairing/settings + host-grouped project cards,
│                                     # Files/Terminals workspace, session rail and touch terminal keys
├── remote-transport/ # standalone Noise XX + bounded encrypted framing (remote protocol 2)
├── connector/ # outbound host connector: exact device approval, route allowlist, manual host leases
├── remote/    # self-hosted Better Auth service + opaque bounded WSS relay; no host content storage
├── cli/       # @puddle-code/cli (the command is `puddle`): serves the UI at localhost:7433 and
│   │          # proxies /api + /ws + /proxy to the daemon on 127.0.0.1:7434 (through the ssh
│   │          # tunnel remotely); bootstrap/handshake/attach live in src/lib/ (no process/TTY
│   │          # access there — the desktop shell reuses it; src/lib/index.ts is the deliberate
│   │          # embedder surface), the bin in src/cli/
│   ├── src/lib/auth/    # connection authority, host-only inspection and protected launcher IPC
│   └── scripts/build.mjs   # esbuild bundle + embeds install.sh + copies web assets into dist/
└── desktop/   # @puddle-code/desktop (private): the Electron shell — a thin main process calling
               # startLocal() from @puddle-code/cli/lib and opening a BrowserWindow on the
               # embedded cockpit. Shell concerns only (windows, OS links, notification raise);
               # anything both shells need goes in cli/src/lib, NEVER here. Build mirrors the
               # CLI's (scripts/build.mjs); `pnpm --filter @puddle-code/desktop dist` packages it.
deploy/remote/       # self-hosted service/static app images, Caddy TLS ingress and private env example
scripts/build-tarball.mjs   # self-contained puddled release tarball for the CURRENT platform
scripts/install.sh          # THE daemon bootstrap (curl-pipeable; the CLI pipes it over ssh)
docs/assets/          # README imagery: cockpit hero screenshots (dark chromeless, light in Mac chrome)
docs/changelogs/      # archived per-version changelogs (see Changelog discipline)
docs/acceptance/      # manual per-phase acceptance scripts (real-agent verification CI can't do)
docs/roadmap/         # deferred feature designs with resolved decisions and implementation seams
docs/reports/         # dated investigation write-ups (root cause + measurements), e.g. perf/battery
```

## Commands

```
pnpm install            # workspace install
pnpm dev                # daemon (watch) + web (vite) for local development
pnpm build              # all packages; web assets land inside the CLI (packages/cli/dist/public)
pnpm test               # vitest across workspaces
pnpm lint               # eslint + prettier check
pnpm test:e2e           # after build: isolated daemon/cockpit process tests, no browser download
pnpm test:remote        # transport, host authority and live relay authentication tests
pnpm test:mobile        # after build: isolated HTTPS browser/connector/daemon flow (Playwright Chromium)
pnpm test:ssh           # after build: loopback OpenSSH integration (sshd + ssh-keygen required)
pnpm build:tarball      # self-contained puddled tarball for this platform (dist-release/)
pnpm --filter @puddle-code/desktop start   # run the Electron shell (after pnpm build; NOT from
                                      # inside an agent session — see the puddled warning below)
pnpm --filter @puddle-code/desktop dist    # package it (dmg/zip/AppImage via electron-builder)
```

For manual testing before a release exists: `pnpm build && pnpm build:tarball`, then
`node packages/cli/dist/index.js launch --tarball dist-release/puddled-v*.tar.gz` (or
`launch user@host --tarball …`). The daemon default port is 7434; the CLI serves the
UI at 7433. `launch` backgrounds itself once ready — pass `--foreground` when
developing so the cockpit stays attached to your terminal (`puddle list` / `puddle
kill` manage backgrounded ones; `puddle refresh` is kill-then-launch in one step, also
reachable from the UI's connection banner).

`puddle install/upgrade/remove <cli|daemon|desktop>[@version] [user@host]`
manage the three components (SPEC §10): install ensures presence, upgrade
moves to newest (or the named version; bare `upgrade` covers everything
installed, CLI last), remove uninstalls behind y/N confirmations — daemon
removal keeps ~/.puddle's data unless purged, and sweeps worktrees for
uncommitted/unpushed work first. cli/desktop are client-machine only;
`upgrade desktop` still installs the macOS app when none exists (writable
`/Applications`, else `~/Applications`); Linux desktop stays in-app-update
only (an AppImage has no fixed install path).

On an SSH host where the installer selected `nohup` but the host reaps that
child as soon as its exec channel closes, `puddle launch` falls back to an
SSH-attached daemon for the cockpit's lifetime. Closing that cockpit cleanly
interrupts live PTYs; SQLite state, worktrees, logs, agent configuration and
agent session refs stay under `~/.puddle`, and boot reconciliation/auto-resume
restores them on the next launch by default (or leaves them resumable when
host auto-resume is disabled). The fallback is allowed only after the
recorded nohup PID is dead — never start a competing daemon beside a live or
supervised one.

> **Never launch `puddled` from inside a coding-agent session** (e.g. a Claude Code terminal, including these dev sessions). The daemon inherits that agent's orchestration env vars — `CLAUDECODE=1`, `CLAUDE_CODE_*` — and passes them to the agents it spawns (PtyManager uses `{...process.env}` by design). A `claude` that sees `CLAUDECODE`/`CLAUDE_CODE_CHILD_SESSION` treats itself as a nested child and **does not write a resumable conversation transcript**, so `--resume` silently fails with "no conversation found" (verified against Claude Code 2.1.209: the identical session persists a transcript with these unset and writes nothing with them set). Start the daemon from a plain shell (systemd/launchd does this in production, so real deployments are unaffected). If a session won't resume during development, check the daemon's env first (`ps eww <pid> | tr ' ' '\n' | grep CLAUDE`).

## Conventions

- **British English everywhere**: comments, documentation, commit messages, UI copy, and identifiers you choose (`colour`, `initialise`, `behaviour`, `licence` as the noun). Exception: never rename third-party API surface — CSS `color`, `Array.prototype.normalize`-style library methods, and external config keys keep their canonical spelling.
- TypeScript strict; no `any` without a comment justifying it.
- Every REST/WS shape is a zod schema in `packages/shared`; daemon validates input, web imports the inferred types. Never define an API shape locally. The schemas are a versioned protocol: any wire-shape change bumps `PROTOCOL_VERSION` per `packages/shared/PROTOCOL.md` in the same commit (additive → minor, breaking → major).
- Connection authority lives in daemon `security/` and CLI `lib/auth/`; browser credentials, connection tokens, host authority and agent signal nonces have separate audiences. Never read a remote master token into the client, persist a connection token, or put invitations in registry records/background logs. Renew streams only through explicit resource ids on the client-participating control channel. Revocation detaches viewers without stopping agents; reconnect never replays uncertain writes. The shared production browser gateway also fronts Vite. Settings → Remote & Sync uses cockpit-local `lib/remote-access.ts` over the current local/SSH transport; registration secrets travel through stdin and host inspection returns public metadata only.
- Mobile access uses self-hosted Better Auth Google/GitHub OAuth only (at least one provider, public signup with provider-verified email, no email/password delivery or recovery), separately trusted application delivery, maintained Noise XX and exact host-approved browser keys. Remote protocol 2 is separate from daemon/cockpit protocol 20.0. Desktop-led account registration uses a five-minute browser-approved hash; its one-use verifier remains in cockpit memory and goes only to the machine status/redemption endpoints. Host identity generation and browser approval remain on the host. `puddle remote` and Settings → Remote & Sync manage host registration, pairing, approval/revocation, disable and local/SSH-only identity reset; desktop settings also delete saved registrations, revoking browsers while retaining the host identity and revoked audit records. Deletion is capability-detected and never exposed through the encrypted remote admin protocol; configuration lives in `~/.puddle/remote`. The complete remote operation allowlist is `connector/src/policy.ts`. New remote operations require review there; never bypass the shared host lease boundary. See `docs/mobile-access.md` and `docs/acceptance/mobile-access.md`.
- Authentication verification uses isolated temporary homes, sanitised subprocess environments and deterministic fake agents. `test:e2e` exercises actual built cockpit replacement; `test:ssh` provisions an ephemeral loopback SSH server. Browser/desktop rendering and interactive SSH acceptance remain manual in `docs/acceptance/connection-authority.md`.
- Puddle home initialisation migrates owned legacy `0755` directories to `0700` before authority access; never rely on `mkdir`'s mode to change an existing directory. Keep `scripts/install.sh` aligned with shared `initialisePrivateHome`; symlinked, foreign-owned and group/other-writable homes remain rejected, and authority subdirectories retain strict validation. Migration tests must include legacy permissions, not only private `mkdtemp` homes.
- Agent-specific behaviour (flags, env vars, session-file locations, status regexes) lives ONLY in that agent's adapter under `packages/daemon/src/agents/`. Core session logic must stay agent-agnostic. When you verify a CLI flag against an installed agent version, record the version you checked in a comment in the adapter.
- Compilable file support uses providers under `packages/daemon/src/`: generic mode/watch/run orchestration stays in `compilation/`, while tool discovery, command arguments, dependency parsing, artefact promotion, and source navigation stay in the provider (LaTeX in `latex/`). The web consumes advertised extensions and artefacts; never hard-code a generic compile path to TeX.
- Agent storage lookup hooks may be asynchronous. Any account-wide discovery must yield to the daemon event loop, bound file reads to the metadata actually needed, and reuse unchanged results across polls; putting synchronous filesystem work inside a background promise still freezes every API and PTY.
- Native conversation discovery returns normalised metadata only and never transcript bodies. The core owns eligibility, canonical-worktree mapping, watch debounce, adaptive fallback polling, missing confirmation, and placement materialisation; adapters own store roots and parsing. Exact live rebinding comes only from an adapter lifecycle channel — catalogue recency must never be used to guess the active conversation.
- Hook/plugin lifecycle channels declare an adapter-owned installed-version check; a failed or unsupported check must launch normally with `native_sync: fallback`, never claim full synchronisation optimistically.
- A live agent is an internal stable runtime whose `activeSessionId` may change after a native clear/resume/fork. Keep PTYs, shells, sidecars, environment, signal nonce, ports, logs/screens, and the one-runtime-per-conversation index together when changing this path; placement switching is serialised by the lifecycle mutex.
- Adapters whose CLIs mint conversation ids (currently Codex and OpenCode) snapshot their existing account/cwd refs before spawn and resolve only a newly appeared ref; recovery validates cwd + native conversation creation time when catalogued, falling back to the placement creation time for legacy rows. Never recover them as merely "the newest conversation in this directory" — concurrent/shared-worktree sessions then collapse onto one agent session ref.
- **Resolved status finding (2026-08-03):** Codex 0.146.0's live idle composer is `› … <model> · <directory>` after ANSI stripping; the older `? for shortcuts` guess never appears. The adapter and Phase 7 acceptance table pin the observed regex. OpenCode and Gemini CLI status patterns remain awaiting live verification.
- SQLite is the source of truth for sessions; PTYs are ephemeral attachments. Schema changes require a migration in `packages/daemon/src/db/migrations/`.
- Every Git mutation shares the `WorktreeManager` mutex keyed by the canonical Git common directory (`gitMutexKey`), so linked worktrees, source-control actions, fetches, and worktree lifecycle commands cannot race Git's lock files.
- This is a public MIT repo: no company-, team-, or person-specific names anywhere (code, tests, docs, examples). Do not copy code from AGPL-licensed projects.
- **Terminology**: a "session" is always an immutable _Puddle placement_ (`sessions.id`: project + canonical worktree + conversation overlay). An agent's own thread is a "native conversation", stored in `agent_conversations`; its public identifier is the "agent session ref" joined onto `Session.agent_session_ref`. A live "runtime" owns the PTYs and may move between placements. Never conflate these three identities in code, comments, or UI copy.
- Design tokens in `packages/web/src/styles/tokens.css` are the single source for colour, type, radius, and spacing; the Tailwind config, xterm theme, and Monaco theme derive from them. Never hard-code a hex value or font stack in a component. UI conventions live in `SPEC.md` §12.
- Remote/mobile UI distils the cockpit: reuse dashboard card content, session glyphs, shared dialogues and the new-session dialogue. Read each profile's desktop project/session order and use the shared ordering helper. The terminal title opens the shared dropdown for active-project sessions; the host/project breadcrumb returns home. Keep host catalogue connections separate from the singleton workspace transport, scope caches/drafts to service/account/host, and detach hidden terminals. The mobile rail shows only the active project's non-archived sessions; Files uses bounded, inert tree/file reads, including validated custom host roots. The terminal image picker shares desktop image paste, fits images within existing remote request limits, and inserts without submitting. Remote allowlist additions belong in `connector/src/policy.ts` with denial tests for neighbouring operations.
- Collapsible disclosures use `components/ui/disclosure.tsx`: native keyboard semantics with a Lucide chevron, never browser triangle markers. Remote status polls must not disable or relabel controls; only explicit operations show pending state. Remote access and profile sync share Settings → Remote & Sync.
- Every hook in a React component runs **above** that component's loading gate. `pnpm lint` enforces `react-hooks/rules-of-hooks`: a hook after an early return changes the hook count when the gate flips and React blanks the whole page (this shipped once, in v0.0.22).
- Layout-tree node ids are **unique within a tree** (`layout-tree.ts` "Node identity"). Anything that COPIES a tree re-ids the copy (`reidNodes`) and anything that combines trees deduplicates (`dedupeIds`): ids are the tiling area's React keys and resizable-panel ids, so a repeat aliases panes and throws "Panel ids must be unique" mid-render (this shipped in v0.0.22–v0.0.23, when it blanked every window).
- A render throw is now caught (`components/error-boundary.tsx`, mounted around the routed view and at the root — SPEC §12), so a crash is a legible message rather than a white page. That is a net, NOT a licence: it neither fixes nor hides anything, the console still gets the error and component stack, and the two invariants above are still what keep the app rendering.
- Prefer small modules with one responsibility over utils grab-bags. If a file passes ~300 lines, look for a seam.
- Web production builds use `vite.build.config.ts` with only web dependencies; the default `vite.config.ts` adds the authenticated development cockpit gateway. Keep CLI imports out of the production configuration so filtered Docker installs remain buildable.
- Remote runtime images explicitly make package metadata, configuration and public assets readable by their unprivileged users. The service's `/data` must start at mode `0700`, owned by UID 10001: Docker copies this metadata into fresh volumes. CI builds from a private checkout and runs `node deploy/remote/test-images.mjs` with a real service volume, read-only filesystems and dropped capabilities; never rely on the operator's umask or relax permissions on deployment secrets. The app's Caddy binary must have no privileged-port file capability: it serves port 8080.

## Housekeeping — read this, future agents

This file is living documentation and part of the definition of done for every change:

- If your change alters the repo map, commands, conventions, adapter interface, or resolves an open question from `SPEC.md` §15 — update this file (and `SPEC.md` where relevant) **in the same commit**.
- **`SPEC.md` must never drift from the code.** Any change to API surface, data model, behaviour, or design decisions updates the corresponding SPEC section in the same commit — an endpoint, flag, or colour that exists only in code (or only in SPEC) is a bug.
- Prune as you go: stale instructions are worse than missing ones. If you find a section here that no longer matches the code, fix it even if your task didn't touch it.
- Keep this file skimmable. Details belong in `SPEC.md` or code comments; this file is the map, not the territory.
- Record resolved design decisions (e.g. "codex resume verified as `codex resume <id>` on v0.x.y") in the place a future agent will look first: the adapter comment, and a line in the changelog.

## Changelog discipline

`CHANGELOG.md` in the repo root is the **rolling changelog for the next release**. Rules:

1. Every user-visible or behaviour-affecting change updates `CHANGELOG.md` **in the same commit/PR** as the change. Internal-only refactors with zero behaviour change may be skipped.
2. Structure follows [Keep a Changelog](https://keepachangelog.com): a single `## [Unreleased]` section with `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Security` subsections (include only non-empty ones). One line per change, imperative mood, reference the PR/issue when it exists.
3. **On publishing version X.Y.Z**:
   - Append `X.Y.Z` and that release's exact protocol to `RELEASE_PROTOCOLS` in `packages/cli/src/lib/component-versions.ts`; this immutable offline ledger identifies older installed components without executing them.
   - Retitle `## [Unreleased]` to `## [X.Y.Z] — YYYY-MM-DD`.
   - Copy the file to `docs/changelogs/CHANGELOG-vX.Y.Z.md` (this is the permanent archive).
   - Reset the root `CHANGELOG.md` to the empty template (see the file's header comment), pointing at `docs/changelogs/` for history.
4. Never edit archived changelogs in `docs/changelogs/` except to fix factual errors.
