# CLAUDE.md — puddle

Puddle is a self-hosted orchestrator for CLI coding agents with first-class SSH support: a persistent daemon (`puddled`) runs on whatever machine hosts the work — your own laptop (`puddle start`) or a remote box (`puddle connect user@host`) — and owns agent PTYs, git worktrees, and session state; a web UI provides project workspaces with terminals, editing, diffs, git history, and port forwarding. The full design is in `SPEC.md` — read it before making architectural changes.

**Read `HUMANS.md` at the start of every session.** It is the human-authored design brief for the UI's feel (minimalism, transparency, no boxes/borders, hover responsiveness) and it overrides SPEC §12 and any framework default wherever they conflict. Any UI work that ignores it is wrong by definition.

## Repo map

```
packages/
├── shared/    # the protocol package: zod schemas for REST + WS messages (the single source of
│              # truth for API shapes) + PROTOCOL_VERSION — read its PROTOCOL.md before schema changes
├── daemon/    # puddled: Hono HTTP/WS server, PTY manager, worktree manager, SQLite
│   └── src/agents/   # one adapter file per coding agent (claude-code.ts, codex.ts, ...)
├── web/       # React UI: Tailwind v4 + owned shadcn-style components (src/components/ui/)
│   ├── src/styles/tokens.css   # THE colour source; scripts/check-tokens.mjs guards it in lint/CI
│   ├── src/lib/       # token gate, TanStack Query hooks, singleton WS manager, theme registry
│   └── src/features/  # dashboard, workspace (sidebar/tabs/xterm), editor/explorer/diff/history
│                      # (Monaco tabs + drafts, file tree + transfer, diff & history views), settings, ⌘K palette
└── cli/       # client launcher: serves the UI + proxies /api & /ws (Phase 6), ssh bootstrap, tunnel
docs/changelogs/      # archived per-version changelogs (see Changelog discipline)
docs/acceptance/      # manual per-phase acceptance scripts (real-agent verification CI can't do)
```

## Commands

```
pnpm install            # workspace install
pnpm dev                # daemon (watch) + web (vite) for local development
pnpm build              # all packages; web assets embed into the daemon
pnpm test               # vitest across workspaces
pnpm lint               # eslint + prettier check
```

> **Never launch `puddled` from inside a coding-agent session** (e.g. a Claude Code terminal, including these dev sessions). The daemon inherits that agent's orchestration env vars — `CLAUDECODE=1`, `CLAUDE_CODE_*` — and passes them to the agents it spawns (PtyManager uses `{...process.env}` by design). A `claude` that sees `CLAUDECODE`/`CLAUDE_CODE_CHILD_SESSION` treats itself as a nested child and **does not write a resumable conversation transcript**, so `--resume` silently fails with "no conversation found" (verified against Claude Code 2.1.209: the identical session persists a transcript with these unset and writes nothing with them set). Start the daemon from a plain shell (systemd/launchd does this in production, so real deployments are unaffected). If a session won't resume during development, check the daemon's env first (`ps eww <pid> | tr ' ' '\n' | grep CLAUDE`).

## Conventions

- **British English everywhere**: comments, documentation, commit messages, UI copy, and identifiers you choose (`colour`, `initialise`, `behaviour`, `licence` as the noun). Exception: never rename third-party API surface — CSS `color`, `Array.prototype.normalize`-style library methods, and external config keys keep their canonical spelling.
- TypeScript strict; no `any` without a comment justifying it.
- Every REST/WS shape is a zod schema in `packages/shared`; daemon validates input, web imports the inferred types. Never define an API shape locally. The schemas are a versioned protocol: any wire-shape change bumps `PROTOCOL_VERSION` per `packages/shared/PROTOCOL.md` in the same commit (additive → minor, breaking → major).
- Agent-specific behaviour (flags, env vars, session-file locations, status regexes) lives ONLY in that agent's adapter under `packages/daemon/src/agents/`. Core session logic must stay agent-agnostic. When you verify a CLI flag against an installed agent version, record the version you checked in a comment in the adapter.
- SQLite is the source of truth for sessions; PTYs are ephemeral attachments. Schema changes require a migration in `packages/daemon/src/db/migrations/`.
- This is a public MIT repo: no company-, team-, or person-specific names anywhere (code, tests, docs, examples). Do not copy code from AGPL-licensed projects.
- **Terminology**: a "session" is always a _puddle_ session (agent + worktree + PTY, `sessions.id`). An agent's own conversation identifier is the "agent session ref" (`sessions.agent_session_ref`). Never conflate the two in code, comments, or UI copy.
- Design tokens in `packages/web/src/styles/tokens.css` are the single source for colour, type, radius, and spacing; the Tailwind config, xterm theme, and Monaco theme derive from them. Never hard-code a hex value or font stack in a component. UI conventions live in `SPEC.md` §12.
- Prefer small modules with one responsibility over utils grab-bags. If a file passes ~300 lines, look for a seam.

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
   - Retitle `## [Unreleased]` to `## [X.Y.Z] — YYYY-MM-DD`.
   - Copy the file to `docs/changelogs/CHANGELOG-vX.Y.Z.md` (this is the permanent archive).
   - Reset the root `CHANGELOG.md` to the empty template (see the file's header comment), pointing at `docs/changelogs/` for history.
4. Never edit archived changelogs in `docs/changelogs/` except to fix factual errors.
