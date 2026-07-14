# Puddle — Specification

Puddle is a self-hosted **orchestrator for CLI coding agents** (Claude Code, Codex, OpenCode, and others) — run many agents in parallel, each isolated in its own git worktree, managed from one workspace UI. A persistent daemon owns agent processes, worktrees, and session history; it runs on whatever machine hosts the work. On your own machine, `puddle start` gives you the cockpit at `localhost`. On a remote box, **first-class SSH support** (`puddle connect user@host`) bootstraps the daemon and reaches the same cockpit over a single tunnel, in the spirit of VS Code Remote-SSH: live agent terminals, file editing, diff review, git history, and port forwarding. Because the daemon — not a login shell or browser tab — is the parent of every agent process, sessions keep running when the laptop sleeps or the window closes, and they survive machine reboots by resuming from each agent's on-disk conversation state.

Puddle is a public, general-purpose tool. Nothing in the codebase, docs, examples, or default configuration may reference any specific company, team, or person. Use generic placeholders (`alice`, `user@devbox`, `my-repo`).

## 1. Goals and non-goals

Goals:

- Run many coding-agent sessions in parallel on one host machine — your own laptop/workstation (local mode) or a remote box (SSH mode) — each isolated in its own git worktree and branch by default (sessions can opt out of branch isolation and share — §4 "Relaxed isolation"). Both modes use the identical daemon and UI; SSH mode only adds bootstrap and a tunnel.
- Support multiple **profiles** (one per collaborator on a shared box) and, within each profile, multiple **accounts** per agent type (separate credential/config dirs), with any number of concurrent sessions per account.
- Organise work into **projects** (profile + repo + sessions + persisted UI state): a window attaches to one project, multiple windows can open the same project, and reloading a window restores the project exactly — open sessions, terminals (via log replay), and editor tabs.
- Full persistence: accounts, sessions, branches, and terminal history survive daemon restarts, SSH disconnects, and machine reboots.
- A browser UI with: session sidebar with live status, xterm.js terminals (agent + shell tabs), Monaco file viewing/editing, diff review against the base branch, git history browsing, detected-port list with forwarding, and clickable file paths / URLs in terminals.
- One-command startup: `puddle start` locally, `puddle connect user@host` for a remote box.
- Agent-agnostic core with per-agent adapters; adding an agent means adding one adapter module.
- A per-profile **prompt bank**: an editable collection of frequently used plaintext prompts, insertable into any session in one action, available across all projects and agents.

Non-goals (v1):

- User authentication/authorisation. Puddle assumes a single trusted OS user; profiles are identity, not access control. (This is distinct from the mandatory browser-facing token in §2 "Local security", which defends the localhost API against malicious web pages, not against local users.)
- Merge automation, PR creation, or conflict resolution.
- Replacing a full IDE. Deep editing happens via "Open in editor" deep links; Monaco covers review and quick edits.
- Multi-machine fleets. One daemon per box; `puddle connect` targets one host at a time. (Keep the CLI's host handling clean so this can grow later.)
- Native Windows hosts. v1 host platforms are Linux and macOS; Windows users are served via WSL2 (which behaves as a Linux host). The client side (browser + CLI tunnel) works from any OS.

## 2. Architecture

```
 client machine                                   host machine (local or remote)
┌──────────────────────────────┐                 ┌───────────────────────────────────┐
│ browser ── localhost:7433    │                 │  puddled  (systemd user service)  │
│               │              │  local: direct  │   ├─ REST + WS API (Hono)         │
│  puddle CLI ◄─┘              │  remote: ssh -L │   ├─ PTY manager (node-pty)       │
│   ├─ static web UI assets    │────────────────►│   ├─ worktree manager (git CLI)   │
│   └─ /api + /ws proxy        │    HTTP + WS    │   ├─ agent adapters (per agent)   │
└──────────────────────────────┘                 │   ├─ SQLite (source of truth)     │
                                                 │   └─ append-only session logs     │
                                                 └───────────────────────────────────┘
```

**The CLI serves the UI; the daemon is a headless API server.** In both local mode (`puddle start`) and SSH mode (`puddle connect user@host`) the browser talks to one stable local origin — `http://localhost:7433`, served by the `puddle` CLI — and the CLI reverse-proxies `/api` and `/ws` to the daemon: directly to `127.0.0.1:7434` locally, through the SSH tunnel remotely. One serving path for both modes, no CORS (single origin), and no host- or tunnel-port detail ever reaches the browser. The daemon is host-agnostic: it binds `127.0.0.1:7434` and neither knows nor cares where the client is. UI updates ship with the CLI — updating the CLI once updates the cockpit for every host it connects to; the daemon is only forced to update when the protocol breaks (§6 Protocol versioning).

> **Transition note (until Phase 6):** the CLI's serve/proxy layer lands in Phase 6. Until then the daemon embeds the built web assets and serves them itself from `127.0.0.1:7433`, and browsers reach it directly (or via a plain `ssh -L` tunnel). The API surface, token flow, and everything from §3 onward are identical in both worlds — the Phase 6 switch relocates serving without touching the contract.

- **`puddled`** (daemon): Node 22 LTS — pinned, and shipped inside the release tarball, so the choice never depends on the host. Hono for HTTP, `node-pty` for terminals, `better-sqlite3` for state; both are native modules and ship prebuilt in the tarball. API only — no web assets (from Phase 6; see the transition note). Binds `127.0.0.1:7434` by default (7433 while it still serves the UI). (Bun is fine as dev tooling; the daemon itself runs on the pinned Node.)
- **Web UI**: React + TypeScript, xterm.js (+ fit, web-links addons), Monaco (`@monaco-editor/react`). Built to static assets shipped inside the CLI npm package (inside the daemon package until Phase 6).
- **`puddle` CLI** (client machine): npm package; bootstraps/updates the daemon (locally or over SSH), serves the web UI and proxies `/api` + `/ws` to the daemon, opens the tunnel when remote, launches the browser, and performs the protocol handshake (§6) on every start/connect.
- **State layout on the host**, all under `~/.puddle/`:

```
~/.puddle/
├── puddle.db                 # SQLite
├── token                     # browser auth token (see Local security)
├── config.json               # daemon settings (port, log caps)
├── profiles/<profile_id>/accounts/<agent_type>/<label>/   # per-account agent config dirs (created by puddle; id-keyed — names are display labels)
├── worktrees/<repo_id>/<session-id>/   # repo_id, not repo name — names can collide
│                      /branch-<slug>/  # shared worktrees for separate_branch = false sessions (§4)
└── logs/<session-id>/<term>.log        # append-only PTY output, one file per terminal (agent.log, shell-1.log, …)
```

Puddle NEVER mutates or adopts agent config directories it did not create (e.g. an existing `~/.claude` or `~/.codex`). Every puddle-managed account gets a fresh directory under its profile's subtree, populated either by puddle's login flow or by **import**: `POST /api/accounts {import_dir}` COPIES a pre-existing config dir into the new puddle-owned dir, byte-for-byte and read-only — the source is never touched again, nothing is parsed beyond the agent's own state file, and the account's logged-in flag is set by asking the agent (adapter `checkLoggedIn`), never assumed (macOS keychains bind OAuth tokens to the source path, so credentials may not travel with a copy). This keeps puddle state disjoint from whatever else runs on the box.

**Puddle never reads credentials — no exceptions.** Subscription rate-limit usage (the profile panel's progress bars) is fetched by asking the agent's own CLI (for claude-code: `claude -p /usage`, print mode, run with the account's config dir), so the agent authenticates itself exactly as an interactive session would and puddle touches no tokens. Results are cached per account in the daemon (each fetch spawns a process) and every failure — logged-out account, missing binary, timeout, unrecognised output — yields no data rather than wrong numbers.

**Accounts are strictly per-profile.** The API never lists, attaches, or spawns with another profile's accounts; the UI's account picker shows only the active profile's. If a collaborator wants to use "your" underlying agent subscription, they log in again under their own profile, producing an independent config dir. Note this is organisational isolation, not security — everything runs as one OS user, so anyone with shell access can read any directory; the goal is preventing accidental credential sharing and history mixing, not defending against a malicious housemate.

### Local security (mandatory, Phase 1)

Binding to `127.0.0.1` is **not** protection from the web: any website open in the user's browser can attempt `fetch("http://localhost:7433/...")`, and DNS-rebinding can defeat naive same-origin assumptions. For a daemon that can spawn agents with permissions skipped, an unauthenticated localhost API is a remote-code-execution vector via CSRF. Therefore, from Phase 1:

1. **Token auth**: the daemon generates a random bearer token at first start (`~/.puddle/token`, mode 0600). The CLI reads it (locally or over the SSH master) and appends it as a URL fragment when opening the browser; the UI reads it, immediately strips it from the address bar (history.replaceState) so it never lingers in history or copied links, stores it, and sends it on every `/api` request and as the first WS message. All `/api`, `/ws`, and `/proxy` routes require it; only the static UI assets (served tokenlessly by the CLI — by the daemon until Phase 6) are public. `puddle attach`/`status`/`logs` use it the same way. The CLI's proxy forwards requests verbatim — it adds no credentials; the token travels from the browser exactly as before.
2. **Host and Origin validation**: reject requests whose `Host` is not `localhost`/`127.0.0.1` (defeats DNS rebinding) and whose `Origin`, when present, is not a localhost origin. The CLI's UI server applies the same two checks on its own port.
3. **Proxy scoping**: `/proxy/:sid/:port/` only forwards to ports currently detected for that session's process tree — it must not be a general localhost proxy.

### Why no tmux

The daemon is the persistence layer. It is the parent of every PTY, runs under systemd, and tees all output to disk. tmux would duplicate that role with a second session registry that can drift. The "attach from a raw terminal" escape hatch tmux provided is replaced by `puddle attach <session>` (CLI → daemon WebSocket).

## 3. Data model (SQLite)

```sql
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,                  -- 10 hex chars, like projects; opaque handle
  name TEXT NOT NULL UNIQUE,            -- display label only (e.g. "alice") — never keys files or URLs
  branch_prefix TEXT NOT NULL DEFAULT '',  -- e.g. "alice/"
  settings TEXT NOT NULL DEFAULT '{}',  -- profile-scope settings JSON (see §11 Settings)
  created_at TEXT NOT NULL
);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  agent_type TEXT NOT NULL,             -- adapter id: 'claude-code' | 'codex' | 'opencode' | ...
  label TEXT NOT NULL,                  -- e.g. "personal", "org"
  config_dir TEXT NOT NULL,             -- under ~/.puddle/profiles/<profile_id>/accounts/
  skip_permissions_default INTEGER NOT NULL DEFAULT 0,  -- effective only when the profile's allowSkipPermissions gate is on (§11 Settings)
  logged_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(profile_id, agent_type, label)
);

CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,            -- canonical clone on the box
  default_base_branch TEXT NOT NULL DEFAULT 'main',
  onboarding_notes TEXT,                -- user-authored standing setup rules, injected into every worktree onboarding (§4)
  fetch_enabled INTEGER NOT NULL DEFAULT 1,    -- master switch for all fetching on this repo (create-time and periodic)
  last_fetched_at TEXT
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,                  -- 10 hex chars: short, stable URL handle (/project/:id)
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,                   -- e.g. "teleop-latency"
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, name)
);

CREATE TABLE project_states (            -- per-(project, profile) persisted workspace layout (see §11)
  project_id TEXT NOT NULL REFERENCES projects(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),      -- layout follows identity, not browser
  ui_state TEXT NOT NULL,                -- JSON: session tabs, editor tabs, layout, explorer pin
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, profile_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                  -- puddle uuid; also worktree dir name
  project_id TEXT NOT NULL REFERENCES projects(id),  -- profile and repo derive from the project
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  worktree_path TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  branch TEXT NOT NULL,
  separate_branch INTEGER NOT NULL DEFAULT 1,  -- 0: works directly on base_branch in a shared worktree (§4)
  agent_type TEXT NOT NULL,
  agent_session_ref TEXT,               -- agent-native id used for resume (see adapters)
  title TEXT,
  status TEXT NOT NULL,                 -- see state machine
  skip_permissions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT
);

CREATE TABLE prompts (                   -- per-profile prompt bank (see §11)
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  title TEXT,                            -- optional short label; body's first line shown if absent
  body TEXT NOT NULL,                    -- plaintext, inserted verbatim
  tags TEXT NOT NULL DEFAULT '[]',       -- JSON array of free-form strings
  project_id TEXT REFERENCES projects(id),      -- optional association — a ranking hint, never a filter
  agent_type TEXT,                       -- optional association — a ranking hint, never a filter
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE events (                    -- lifecycle audit trail
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  type TEXT NOT NULL,                    -- created|resumed|interrupted|exited|archived|...
  payload TEXT,                          -- JSON
  created_at TEXT NOT NULL
);
```

SQLite is the source of truth; a live PTY is an ephemeral attachment to a durable session row. All timestamps are ISO 8601 UTC. Git operations against a given repo (worktree add/remove, fetch, branch creation) are **serialised through a per-repo mutex** in the daemon — concurrent `git worktree` invocations on one repo race on git's own lock files and fail spuriously.

## 4. Session state machine

```
            spawn                     agent prompt detected
 starting ────────► running ◄───────────────────────────► waiting_input
                      │  ▲                                      │
        process exit  │  │ resume                               │ process exit
                      ▼  │                                      ▼
                    exited ◄────────────────────────────── (same as running)
                      │
   daemon boot finds  │            user archives (worktree removed)
   no live PTY  ──► interrupted ─────────────► archived
```

- `starting` covers worktree creation: the daemon fetches per the fetch policy below and creates the worktree (base resolves to `origin/<base>` when it exists, so sessions never branch off a stale local base). Environment setup then happens **inside the agent session** via onboarding (below), guided by the repo's `onboarding_notes`.
- `starting → running` when the agent's PTY produces first output.
- `running ⇄ waiting_input` driven by the adapter's `statusPatterns` matched against the output stream (debounced; a session is `waiting_input` only after ~2 s of quiet following a match).
- Any of `{starting, running, waiting_input}` found without a live PTY during the daemon's boot **reconcile pass** → `interrupted`. Reconcile also sweeps the filesystem: a worktree directory with no session row is flagged in the UI (never auto-deleted); a session whose worktree is missing is badged "worktree missing" and can only be archived.
- `exited` / `interrupted` → `running` via resume (adapter `resumeArgs`, same worktree, same config dir). On resume after `interrupted`, the daemon injects a first message: _"This session was interrupted (daemon or machine restart). Processes you started are gone; re-verify your environment before continuing."_
- `archived`: reachable only from `exited` or `interrupted` (a running session must be killed first). Archiving removes the worktree (only if clean, or with explicit confirmation; a shared worktree is removed only when its **last** non-archived session archives) and retains logs. The branch is kept by default, but the archive dialog offers **delete the branch too** (`delete_branch` — `git branch -D`, so a branch never pushed to origin leaves no trace; unpushed commits are gone for good). Branch deletion applies only to separate-branch sessions — puddle never deletes a branch it did not create — and project archive never deletes branches. Archiving a **project** archives all its sessions and refuses while any is `running`/`waiting_input` unless forced.
- Auto-resume on boot is OFF by default (`config.json: autoResume: false`); interrupted sessions surface in the UI for one-click resume.

### Relaxed isolation: shared-worktree sessions

Branch-per-session is the default, not a straitjacket. A session created with `separate_branch: false` works **directly on its base branch** — no new branch, no isolation — in a worktree shared by every other such session on the same branch:

- One shared worktree per (repo, branch), at `worktrees/<repo_id>/branch-<slug>/`. The first shared session creates it (checking the branch out with `git worktree add --force` — the branch may legitimately also be checked out in the canonical clone; the double checkout is the point of this mode, and each checkout keeps its own index and working tree while commits land on the one branch); later shared sessions attach to the existing directory.
- **Deliberately discouraged.** The new-session modal's "use separate branch" toggle is on by default; switching it off hides the Branch field and shows a warning spelling out the loss of isolation (concurrent agents in one directory can and will trample each other's edits). The daemon rejects a `branch` name combined with `separate_branch: false` (400 `branch_with_shared`).
- Only the session that **created** the worktree receives the onboarding preamble and the `.puddle/` marker-file watch; attaching sessions get their prompt bare (the environment already exists, as with resumes and hand-offs).
- Archiving removes the shared worktree only when the last non-archived session using it archives; the branch itself is never deleted by puddle (it isn't puddle's), and branch pickers do not badge it as a session branch.

Environment setup is not deterministic per repo — whether _this particular worktree_ needs a fresh `.venv`, a symlink to a shared one, or none at all is often the user's call in the moment. So setup is split into **standing rules** and **per-worktree discretion**:

1. **Standing rules — `repos.onboarding_notes`.** A user-authored, freeform text block per repo (editable in Repositories settings), holding whatever the user has decided is always true: "always `pnpm install`", "shared `.venv` lives at `<repo>/.venv`; symlink it unless I say otherwise", "never install playwright browsers", "ask me before touching Docker". Empty is fine — everything is then discretionary.
2. **Every freshly created worktree onboards — and only those.** The daemon prepends an _onboarding preamble_ to the agent's first prompt (or delivers it alone when the session was started without a task prompt): read the notes; inspect the codebase for setup requirements (README/CONTRIBUTING, lockfiles, `.tool-versions`, `pyproject.toml`, …); **apply what the notes settle without asking; ask the user about anything the notes leave open** — stating trade-offs where relevant (a symlinked `.venv` saves gigabytes per worktree, but parallel sessions then share mutable dependency state). Execute only what the notes prescribe or the user approves, then proceed to the user's actual task. Sessions that _reuse_ an existing worktree — resumes, and tier-2 hand-offs (§5) — never receive the preamble; their environment already exists, and the resume note or hand-off prompt takes its place.
3. **Rules can be taught through the agent.** If during onboarding the user states a standing rule ("always do X from now on"), the preamble instructs the agent to write the updated notes to `.puddle/onboarding-notes.md` in the worktree; the daemon syncs that file into `repos.onboarding_notes` and confirms with a toast. Syncs are last-writer-wins (several sessions can onboard concurrently), so the daemon logs the previous notes to `events` and the toast links the change — an unwanted overwrite is one click to inspect and revert. The notes remain user-owned prose — the agent records decisions, it doesn't invent policy. (`.puddle/` is git-excluded, never committed.)
4. **Agents name their own sessions.** The preamble also asks the agent to write a short description of its task to `.puddle/session-title`; the daemon syncs it into `sessions.title` (capped at 80 chars) whenever the file's content actually _changes_, so unnamed sessions label themselves once the agent understands the work. It reacts only to genuine edits — an unrelated `.puddle` write (a pasted image, a notes edit) never re-applies stale file content, so a title set from the UI (`PATCH /api/sessions/:id`) is not clobbered. Either path broadcasts a `renamed` message, so every attached client updates live. The git branch is fixed at creation and never renamed by this.

Notes are **repo-global, shared by all profiles** — like the repo itself on a trusted box. Genuinely personal preferences are expressed in the moment (per-worktree answers); if that proves noisy in practice, a per-profile notes addendum is a natural later extension, deliberately not in v1.

The prescriptiveness of the notes is the automation dial: exhaustive notes make onboarding near-silent (the agent just executes and gets on with the task); sparse notes mean a question or two per worktree — which is exactly right when the answer genuinely varies per worktree. Onboarding runs under the session's normal permission rules — the gate (§11) is not bypassed for setup.

### Fetch policy

Base-branch freshness is treated as ambient hygiene, not a user chore. The daemon runs `git fetch` (fetch only — worktrees and local branches are never mutated):

- **on session creation** (before branching, as above),
- **on project open** (any client loading `/project/:id`),
- **periodically** in the background — `config.json: fetchIntervalMinutes`, default 15 — for every repo with at least one non-archived session.

All fetches use the OS user's normal git credentials, are serialised through the per-repo mutex, and update `repos.last_fetched_at`. Per-repo opt-out (`fetch_enabled = 0` — disables create-time, open-time, and periodic fetching alike) exists for air-gapped boxes. For repos with no remote, fetching and freshness indicators degrade silently (ahead/behind is computed against the local base). Otherwise the UI shows each session's ahead/behind counts against `origin/<base>` and a subtle "base moved" indicator when the base branch has advanced since the session branched — surfacing drift early instead of at merge time. Fetch failures (offline, auth) are logged and shown as a muted repo badge; they never block session creation.

## 5. Agent adapters

The core is agent-agnostic. Each agent is one module in `packages/daemon/src/agents/<id>.ts` implementing:

```ts
export interface AgentAdapter {
  id: string; // 'claude-code', 'codex', 'opencode'
  displayName: string;
  binary: string; // executable name to resolve on PATH
  capabilities: {
    resume: boolean; // can restore a conversation
    presetSessionId: boolean; // id can be chosen at launch
    skipPermissions: boolean; // has a yolo/skip-prompts mode
    migratableSessions: boolean; // conversation state can move between accounts (same agent)
  };
  env(account: AccountRow): Record<string, string>; // config-dir isolation
  launchArgs(opts: LaunchOpts): string[]; // fresh session
  resumeArgs(ref: string, opts: LaunchOpts): string[]; // restore session
  loginArgs(): string[]; // interactive login flow
  // Returns the agent-native session ref. Either echoes the preset id, or
  // discovers it post-launch (e.g. newest session file in the config dir).
  resolveSessionRef(opts: LaunchOpts, account: AccountRow): Promise<string>;
  // Move a conversation's on-disk state from one account's config dir to another's
  // (same agent type). Only called when capabilities.migratableSessions.
  migrateSession?(ref: string, from: AccountRow, to: AccountRow, worktree: string): Promise<void>;
  // Render the conversation as readable text (for cross-agent hand-off). Falls back
  // to the puddle PTY log tail when the agent's native format can't be parsed.
  exportTranscript?(ref: string, account: AccountRow, worktree: string): Promise<string>;
  statusPatterns: { waitingInput: RegExp[]; busy?: RegExp[]; limitReached?: RegExp[] };
}
```

`statusPatterns` are matched against the output stream **after stripping ANSI escape sequences** — agent TUIs colour their prompts, and regexes written against clean text silently never match raw PTY bytes.

Capability notes per adapter (**verify every flag against the installed version during Phase 1/7 — agent CLIs change fast; encode findings in the adapter, never in core**):

- **claude-code**: isolation via `CLAUDE_CONFIG_DIR`; supports `--session-id <uuid>` at launch (→ `presetSessionId: true`) and `claude --resume <uuid>`; skip mode `--dangerously-skip-permissions`; conversations stored as JSONL under `<config_dir>/projects/<escaped-cwd>/<uuid>.jsonl`.
- **codex**: isolation via `CODEX_HOME`; sessions recorded under `$CODEX_HOME/sessions/`; resume via `codex resume <id>` (or `--last`); bypass mode `--dangerously-bypass-approvals-and-sandbox`. Session id is discovered post-launch.
- **opencode**: config/state via its config dir env (XDG-based); has session continue/resume support; permissions configured rather than flagged.

When a capability is `false`, degrade gracefully: e.g. no `resume` → offer "new session in the same worktree", pre-filling a prompt that summarises the branch state (`git log --oneline base..HEAD` + `git status`).

Adding an agent = adding one file + registering it; PRs adding adapters must not touch core session logic.

### Continuing work across accounts and agents

Two tiers, surfaced as one "Continue on…" action in the session menu (and offered proactively when `limitReached` fires — see below):

- **Tier 1 — same agent, different account (migration).** The conversation itself moves. The session's process is stopped (it has usually already exited — credit exhaustion), the adapter's `migrateSession` relocates the conversation's on-disk state from account A's config dir to account B's (for claude-code: the session JSONL under `<config_dir>/projects/<escaped-cwd>/<uuid>.jsonl` — the escaped cwd is identical because the worktree doesn't change), `sessions.account_id` is updated, and the normal resume path runs with account B's env. Same worktree, same branch, same conversation, different credentials. An `events` row records the migration. **Caveat the implementation must respect**: agent session-file formats are undocumented and can change between versions — `migrateSession` verifies the resume actually restored the conversation (adapter-specific check) and rolls the file back on failure, falling through to tier 2.
- **Tier 2 — different agent (hand-off).** No shared conversation format exists, so the conversation is _summarised, not moved_: a new session is created in the **same worktree** on the target agent/account, seeded with a hand-off prompt built from the source adapter's `exportTranscript` (tail-truncated), plus `git log --oneline base..HEAD` and `git status`. The original session remains in its terminal state with an event linking the two. Degraded by design — the new agent knows _what happened_, not the old agent's private reasoning — but the working tree, branch, and task context carry over completely.

**Limit detection**: adapters may provide `limitReached` patterns (e.g. Claude Code's usage-limit message). On match, the session is badged in the sidebar and the notification (Phase 8) offers "Continue on…" directly — turning the out-of-credit moment from a dead end into two clicks.

## 6. API surface

All REST endpoints are JSON under `/api`. Request/response shapes live as zod schemas in `packages/shared` and are the single source of truth for both daemon and UI.

```
Version    GET  /api/version                 # {version, protocol: {major, minor}} — the handshake endpoint (see Protocol versioning below)
Profiles   GET  /api/profiles                POST /api/profiles {name, branch_prefix?}   # ids are 10-hex handles, like projects
           PATCH /api/profiles/:id {branch_prefix}   # name is immutable in v1 (display label; dirs are id-keyed, so rename support can come later)
           DELETE /api/profiles/:id                  # 409 while any of its sessions is non-archived; cascades rows + removes its dir
           GET  /api/profiles/:id/settings   PATCH (profile-scope settings JSON — §11 Settings)
Config     GET  /api/config                  PATCH (daemon-scope settings; affects all profiles; the port lives in config.json / --port only and is never surfaced in the UI)
Host       GET  /api/host                    # daemon identity {username, hostname, home} — the UI's location indicator; the origin/port never appears in the UI
Agents     GET  /api/agents                  # registered adapters: id, display name, capabilities the UI gates on
Accounts   GET  /api/accounts?profile=…      POST /api/accounts {profile_id, agent_type, label, skip_permissions_default?, import_dir?}   # import_dir: copy a pre-existing config dir (§2)
           PATCH /api/accounts/:id {skip_permissions_default?}   # §11 gate opt-in
           DELETE /api/accounts/:id                  # 409 while any of its sessions is non-archived; removes the config dir (logs the account out)
           POST /api/accounts/:id/login      # spawns interactive login PTY; UI attaches like a session
           GET  /api/accounts/:id/usage      # session counts + last activity (puddle); best-effort agent token totals; live_usage (context fill %, cost) via the status line; subscription rate-limit windows via the agent's own CLI (logged-in accounts, daemon-cached) — all nullable
Repos      GET  /api/fs/dirs?prefix=…        # directory autocomplete for repo registration (dirs only, dotdirs included, is_git flag)
           GET  /api/repos                   POST /api/repos {path, default_base_branch?, onboarding_notes?, fetch_enabled?}
           PATCH /api/repos/:id               # same fields (onboarding_notes also updatable via the .puddle marker-file sync — §4)
           POST  /api/repos/:id/fetch         # manual fetch now; path must be an existing git repo (validated on POST; ~ expands on the host; re-registering a known path returns it)
           GET   /api/repos/:id/branches      # local + fetched remote heads, deduped, default base first; entries are {name, is_session, session_title} so pickers can label puddle-owned branches
Projects   GET  /api/projects?profile=…      POST /api/projects {profile_id, repo_id, name}   # ids are 10-hex handles (/project/:id)
           GET  /api/projects/:id            # detail incl. sessions with status
           GET  /api/projects/:id/state?profile=…   PUT (profile-keyed ui_state JSON; debounced writes; GET falls back to the project's most recent snapshot when the profile has none)
           POST /api/projects/:id/archive
Sessions   GET  /api/sessions?project=…&status=…
           POST /api/sessions {project_id, account_id, base_branch?, branch?, separate_branch?, title?, prompt?, skip_permissions?}
                # separate_branch defaults true; false = work directly on the base branch in a shared
                # worktree (§4 Relaxed isolation) — branch must then be absent (400 branch_with_shared)
                # branch naming: requested branch → prefix + title slug → prefix + first words of the
                # prompt → prefix + a memorable word pair (quiet-tarn) — never a uuid fragment
                # skip_permissions is honoured only if the profile gate AND the account opt-in allow it;
                # otherwise the request is rejected (400) — enforced server-side, no CLI/API bypass
           GET  /api/sessions/:id            # detail incl. git summary (ahead/behind, dirty files)
           PATCH /api/sessions/:id {title?}   # rename (does not rename the git branch)
           POST /api/sessions/:id/resume | /kill | /archive   # archive body: {force?, delete_branch?} — delete_branch
                # only for separate-branch sessions (§4); project archive never deletes branches
           POST /api/sessions/:id/migrate {account_id}    # tier-1: same agent, move conversation (§5)
           POST /api/sessions/:id/handoff {account_id}    # tier-2: new session, transcript hand-off; returns new session id
                # both: target account must belong to the session's profile (400 otherwise);
                # migrate additionally requires the same agent_type; skip_permissions is re-evaluated (§11)
Prompts    GET  /api/prompts?profile=…&q=…&tag=…    # full-text over title/body/tags
           POST /api/prompts {profile_id, body, title?, tags?, project_id?, agent_type?}
           PATCH/DELETE /api/prompts/:id
           POST /api/prompts/:id/used     # bump use_count / last_used_at (called on insert)
Files      GET  /api/worktrees/:sid/tree?path=…
           GET  /api/worktrees/:sid/file?path=…      PUT (write; body = full content, optimistic mtime check)
           GET  /api/worktrees/:sid/resolve?path=…&line=…   # validates terminal-link targets
           POST /api/worktrees/:sid/paste {mime, data}      # base64 clipboard image → .puddle/pastes/; returns {path} relative to the worktree (§7)
           POST /api/worktrees/:sid/upload?dir=…            # multipart file upload into a worktree directory, path-contained (drag-in transfer — §8)
           GET  /api/worktrees/:sid/download?path=…         # file → bytes; directory → zip stream (Content-Disposition attachment) (§8)
Git        GET  /api/worktrees/:sid/diff?against=base|<sha>   # name-status list
           GET  /api/worktrees/:sid/file-at?ref=…&path=…      # blob content for DiffEditor 'original'
           GET  /api/worktrees/:sid/log?limit=…&skip=…        # history
           GET  /api/worktrees/:sid/show/:sha                 # commit detail + changed files
Ports      GET  /api/sessions/:id/ports       # detected listeners for the session pid tree (platform-specific — §9)
Proxy      ALL  /proxy/:sid/:port/*           # tier-2 HTTP reverse proxy, WS upgrade passthrough
```

WebSocket at `/ws`, message envelope `{t: string, ...}`:

```
client → server:
  {t:'attach',  session, term, cols, rows}     # term: 'agent' or a shell id ('shell-1', …)
  {t:'stdin',   session, term, data}
  {t:'resize',  session, term, cols, rows}
  {t:'detach',  session, term}
  {t:'spawn-shell', session}                   # bash PTY cd'd into the worktree; reply carries the new shell id
  {t:'subscribe-status'}                       # sidebar live updates

server → client:
  {t:'shell-spawned', session, term}           # id for a spawn-shell request
  {t:'replay',  session, term, data}           # tail of that term's on-disk log on attach
  {t:'output',  session, term, data}
  {t:'status',  session, status, last_activity_at}
  {t:'renamed', session, title}                # title changed (UI rename or agent self-naming)
  {t:'exit',    session, term, code}
  {t:'error',   message}
```

**Multi-viewer semantics**: any number of viewers (browser windows/tabs, `puddle attach`) may attach to the same session concurrently; `output`, `status`, `renamed`, and `exit` are broadcast to all attached viewers, and `stdin` is accepted from any of them (last-writer-wins, like tmux). A PTY has exactly one size: the most recent `attach`/`resize` wins, and the daemon delivers the resize (SIGWINCH) so full-screen agent TUIs redraw at the new size — smaller concurrent viewers scroll rather than reflow. Log replay renders recorded bytes verbatim; scrollback recorded at a different width may wrap imperfectly (accepted v1 limitation — live content redraws correctly on attach). **A window binds to one project**: routes are `/` (project dashboard), `/project/:id` (the workspace — session tabs, terminals, editor), and within it `/project/:id/session/:sid[/diff|/history]`. Opening the same project in two windows shows the same workspace; opening two projects gives two independent workspaces. Everything is deep-linkable, so reloading a window (or opening it on another laptop) lands back in the same project state.

### Protocol versioning and compatibility

The CLI (and the UI it serves) and the daemon ship separately from Phase 6, so the communication layer — every REST shape and WS message above — is a versioned contract. Two version numbers exist and must not be conflated:

- **App version**: the npm/tarball semver (`puddle --version`, `puddled --version`). Says nothing about compatibility.
- **Protocol version**: `PROTOCOL_VERSION = {major, minor}`, exported from `packages/shared` — the protocol package. `packages/shared` already holds every REST and WS schema as executable zod definitions; it _is_ the protocol description, and the single source of truth for it. `packages/shared/PROTOCOL.md` documents the bump rules; there is deliberately no second, prose copy of the schema anywhere — prose copies drift.

**Compatibility rule: same `major` ⇒ compatible, in both directions.** Everything within a major is additive-only:

- _Additive (bump `minor`)_: a new endpoint, a new optional request/response field, a new WS message type, a new enum value peers may ignore.
- _Breaking (bump `major`, reset `minor`)_: removing or renaming an endpoint, field, or WS message; changing a type or the semantics of an existing field; changing auth or the WS handshake.

Two wire rules make the additive path safe: receivers **ignore unknown WS message types** and **tolerate unknown JSON fields** (schemas use loose objects where extension is expected). A newer client on an older daemon feature-detects against the daemon's `minor` and hides what the daemon cannot do; an older client on a newer daemon simply never asks for the new things.

**Handshake** (CLI, on every `start`/`connect`, before opening the browser):

- `protocol.major` equal → proceed. App-version skew within a major is normal and silent; `puddle upgrade` remains available but is never required.
- Daemon `major` older → the CLI **updates the daemon automatically** (re-runs the bootstrap — §10): print the count of live sessions that will be interrupted, update, restart; sessions resume through the normal reconcile path (§4). `--no-upgrade` aborts instead of updating, for the rare case the user must not interrupt work now.
- Daemon `major` newer (this host was updated by a newer CLI elsewhere) → the CLI cannot fix itself mid-run; refuse with the exact one-line upgrade command for the CLI.

This is the Docker-daemon model reduced to its useful core: a negotiated, versioned local API — but because the CLI owns daemon installation, we keep exact-major lockstep via auto-update instead of maintaining server-side compatibility shims for old clients.

## 7. Terminal UX (links and click-through)

- **URLs**: xterm.js `web-links` addon; plain click (or cmd+click—match both) opens in a new browser tab. In SSH mode, URLs pointing at `localhost:<port>` on the host are rewritten to the tier-2 proxy path so they work from the client (this rewriting therefore lands with Phase 5, not Phase 4); in local mode they are left untouched.
- **File paths**: a custom xterm.js link provider (`registerLinkProvider`) matching `path(:line(:col)?)?` patterns (`src/foo.ts:12:3`, `./a/b.py`, absolute paths inside the worktree). On hover, validate via `GET /resolve` before underlining; on cmd/ctrl+click, open the file in a Monaco tab at that line. This mirrors how VS Code/Cursor terminals behave.
- **Image paste**: pasting an image into a terminal (an `image/*` clipboard item with no text alternative — screenshots, copied images) uploads the bytes via `POST /api/worktrees/:sid/paste` into the session worktree's `.puddle/pastes/` (git-excluded like the rest of `.puddle/` — §4) and inserts the returned worktree-relative path into the terminal's stdin, unsubmitted, for the agent to read. This is what makes image paste work in SSH mode: the agent's own clipboard read (e.g. Claude Code's Ctrl+V) happens on the host machine, whose clipboard does not hold the client's image — so the bytes travel over the API instead. Works identically in local mode; mixed clipboards (text + image) keep xterm's normal text-paste path. Capped at 20 MiB; png/jpeg/gif/webp.
- **macOS line editing**: on Mac clients the browser eats ⌘←/⌘→ (history back/forward) before the PTY sees them. A custom xterm key handler intercepts them (and ⌘⌫/⌘⌦) and sends the readline control codes instead — ⌘← → `Ctrl-A` (line start), ⌘→ → `Ctrl-E` (line end), ⌘⌫ → `Ctrl-U` (delete to start), ⌘⌦ → `Ctrl-K` (delete to end) — matching native macOS field behaviour. Applied only on Mac, so the Meta/Super key is untouched elsewhere.
- **Open in editor**: per-worktree button emitting `cursor://vscode-remote/ssh-remote+<host><worktree_path>` and the `vscode://` equivalent; host is provided by the CLI at connect time (`?host=` param) or configured in the UI.

## 8. Editor, diff, and git history

- **File explorer**: the tree is always bound to exactly one worktree — there is no merged project-wide view. By default it **follows the active session**: switching session tabs switches the tree to that session's worktree. A pin control on the explorer header locks it to a chosen worktree (so you can read session A's files while watching session B's terminal); the header always names the bound worktree/branch, and a dropdown lists the project's worktrees for manual switching. Unpinning re-enables follow-the-session.
- **Editor tab identity is (session, path)**, not path alone: `src/api.ts` in two worktrees is two different files with independent dirty state. Tabs are labelled with the branch when the same path is open from more than one worktree (`api.ts — alice/fix-auth`).
- **Monaco** for file view/edit. Saving PUTs the full file; daemon writes to the worktree so running agents see the change immediately.
- **Diff tab**: Monaco `DiffEditor`; `original` = `file-at?ref=<base>`, `modified` = the live working file with `readOnly:false`, so agent output can be hand-tweaked inside the diff. New files render as a plain editor. Multi-file overview = stacked per-file DiffEditors (virtualised list); no attempt at a single-instance multi-file diff.
- **File transfer** (client ⇄ worktree): dragging files from the OS onto the file explorer uploads them into the hovered folder of the bound worktree (`POST /upload`; multiple files per drop, path-contained to the worktree, size-capped); pasting copied files into the explorer does the same. A context menu on any explorer file or folder offers **Download** (`GET /download` — a single file streams as-is, a folder arrives as a zip built on the host). Remote→local drag-out is not portable across browsers (Chromium-only `DownloadURL`), so the download action is the v1 mechanism; drag-out can be layered on later as a progressive nicety. Everything rides the normal authenticated API through the tunnel, so local and SSH modes behave identically.
- **History tab**: commit list from `/log` (graph optional later); clicking a commit shows its changed files, each opening a DiffEditor of `sha^ → sha`. Covers "tap into the worktree and see git histories." Absolute commit dates render in UTC (not the viewer's local zone): `authored_at` carries the author's own offset anyway, and one fixed zone keeps the formatting deterministic everywhere (including under test).

## 9. Ports

- **Detection**: listening ports owned by the session's process tree — `ss -tlnp` on Linux, `lsof -iTCP -sTCP:LISTEN` on macOS (the daemon picks per platform).
- **Local mode**: ports are directly reachable; the table shows plain `http://localhost:<port>` links, no forwarding needed.
- **SSH mode, tier 1 (Phase 5)**: the table shows a copyable `ssh -L <port>:127.0.0.1:<port> user@host` command per port.
- **SSH mode, tier 2**: `/proxy/:sid/:port/` reverse proxy through the already-open tunnel, including WebSocket upgrade (HMR), scoped per §2 Local security. On a proxy request for an unknown port, re-scan the session's ports once before rejecting — a just-started dev server shouldn't 403 until the next poll. Document the known limitation: apps that assume they are served from `/` (absolute asset paths) may need their base path configured; surface a per-port "open via proxy" and "copy ssh -L" pair so there is always a working path.

## 10. `puddle` CLI (client)

```
puddle start   [--port <p>] [--no-browser]      # local mode: ensure puddled runs on THIS machine, open the UI
puddle connect user@host [--port <local>] [--remote-port <p>] [--no-browser]   # SSH mode
puddle status  [user@host]
puddle attach  [user@host] <session>   # raw-terminal attach over the WS
puddle upgrade [user@host]
puddle logs    [user@host] [session]
```

`start` (local mode): install/upgrade the daemon under `~/.puddle/bin`, ensure the systemd user unit (same as remote), run the protocol handshake (§6), serve the UI at `http://localhost:7433` with `/api` + `/ws` proxied to the daemon on `127.0.0.1:7434`, open the browser. No SSH, no tunnel — but the same serve/proxy path as remote mode. `status`/`attach`/`logs`/`upgrade` default to the local daemon when no host is given.

The UI server picks `7433` by default and auto-picks the next free port when it is taken (e.g. a second `puddle connect` to a different host); the chosen origin is printed and opened. Whether one CLI process can multiplex several hosts behind a single origin is an open question (§15) — v1 is one CLI process, one host, one origin.

### Distribution and bootstrap

- **Release artefact**: self-contained per-platform tarballs (`puddled-v<X.Y.Z>-{linux,darwin}-{x64,arm64}.tar.gz`) published on GitHub Releases with a checksums file. Each contains a pinned Node runtime, the bundled daemon, and prebuilt `node-pty` binaries — no Node, npm, or compiler is assumed on the host; only libc and `git`. The web UI assets ship inside the `puddle` CLI npm package (inside the daemon tarball only until Phase 6), so a UI release is `npm update -g puddle` on the client, touching no host.
- **Install location**: entirely under the home directory, never sudo: `~/.puddle/bin/versions/<X.Y.Z>/` with a `~/.puddle/bin/current` symlink. Upgrade = unpack new version, flip symlink, restart service (running sessions become `interrupted` and resume — the normal reconcile path). Rollback = flip the symlink back. Uninstall = stop the service and `rm -rf ~/.puddle`.
- **Bootstrap** (shared by `start` and `connect`): detect platform (`uname -sm`), fetch the tarball — host-side `curl` from GitHub Releases (checksum-verified), falling back to `scp` from the CLI's cached copy for hosts without outbound internet — unpack, then install a supervisor:
  - Linux: systemd **user** unit `~/.config/systemd/user/puddled.service` (`Restart=always`), `systemctl --user enable --now`, plus `loginctl enable-linger $USER` for boot-start without login.
  - macOS: launchd agent `~/Library/LaunchAgents/dev.puddle.puddled.plist` with `KeepAlive`.
  - Neither available: nohup + pidfile fallback with a printed warning that reboot auto-start is not configured.
- **Manual path**: a documented `install.sh` one-liner performing the same steps, for daemon-only installs without the CLI.
- **Version handshake**: on every `start`/`connect` the CLI compares `protocol.major` from `GET /api/version` and acts per §6 Protocol versioning — automatic daemon update on an older major (with the live-session interruption count printed; `--no-upgrade` aborts instead), a CLI-upgrade refusal on a newer major, and nothing at all on a match: app-version skew within a protocol major is normal.

`connect` (SSH mode) flow:

1. Open a **master SSH connection** with multiplexing (`-o ControlMaster=auto -o ControlPath=~/.puddle/cm-%r@%h:%p -o ControlPersist=10m`), run interactively with the user's TTY inherited. Password, keyboard-interactive, and 2FA prompts therefore come from the `ssh` binary itself and are typed at most once per `connect`; every subsequent exec and the tunnel reuse the master connection. Puddle never reads, stores, or proxies credentials. Over the master: check `~/.puddle/bin/puddled --version`.
2. If missing/outdated: run the bootstrap above over the master connection (platform detect → fetch → unpack → supervisor install).
3. Open the tunnel `ssh -N -L <tp>:127.0.0.1:7434 user@host` over the master connection (`<tp>` is an auto-picked free local port — pure transport, never user-visible), run the protocol handshake, then serve the UI at `http://localhost:7433` (or the next free port) with `/api` + `/ws` proxied through the tunnel, and open the browser at `http://localhost:7433/?host=user@host`.
4. Keep the tunnel and UI server in the foreground with auto-reconnect; Ctrl-C closes them only — the daemon and agents keep running.

Use the system `ssh` binary (spawned), not a JS SSH library: it inherits the user's `~/.ssh/config`, agents, jump hosts, password/2FA prompting, and MFA for free. If no key is set up, `connect` works over password auth via the master connection; print a one-line hint suggesting `ssh-copy-id` for a smoother experience.

Implement the CLI as a thin `bin` wrapper over library functions in `packages/cli/src/lib/` (bootstrap, tunnel, attach are all importable). This keeps the door open for a future desktop shell (e.g. Electron/Tauri) that reuses the same logic from a main process instead of a terminal.

## 11. Profiles and projects

Profiles are identity, not auth. First load shows a profile picker (create-or-select), remembered in localStorage.

### Settings

A settings panel, reachable from a gear icon and ⌘K → "Settings". Three scopes, each stored where it belongs:

| scope   | storage                                                    | examples                                                                                                                                                                |
| ------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| client  | localStorage (per browser)                                 | theme (dark/light/system), UI & terminal font size, reduced motion, terminal scrollback, editor tab size / word wrap                                                    |
| profile | `profiles.settings` JSON, via `/api/profiles/:id/settings` | branch prefix, default account & agent, permissions gate, notification preferences                                                                                      |
| daemon  | `config.json`, via `/api/config`                           | log size cap, ui_state GC retention, `autoResume` — marked in the UI as affecting all profiles. The port is CLI/config-file territory (`--port`), never shown in the UI |

Panel sections: **Appearance** (theme, font sizes, density, reduced motion); **Profile** (name, branch prefix, default account & agent); **Accounts** (per agent type: login state, add — spawns the login PTY —, remove; per-account "skip permission prompts" toggle, visible only when the gate below is on); **Permissions & safety**; **Notifications** (desktop notification and optional sound on `waiting_input`, per-project mute); **Terminal & editor**; **Repositories** (per repo: base branch, fetch policy, onboarding notes — the standing setup rules, freely editable); **Host** (daemon scope, incl. `fetchIntervalMinutes`).

**Permission prompts are ON by default, everywhere.** Spawning an agent with prompts skipped (e.g. `--dangerously-skip-permissions`) requires deliberate, layered opt-in:

1. The profile's `allowSkipPermissions` gate (Permissions & safety) is **off** by default. Enabling it shows a warning dialogue that spells out what an unattended, prompt-free agent can do, and requires typing the profile name to confirm.
2. With the gate on, individual accounts can opt in (`skip_permissions_default`), and only then does the new-session modal show a per-session skip toggle.
3. The daemon enforces the gate server-side: `skip_permissions: true` against a closed gate is rejected — there is no CLI, API, or UI bypass.
4. **Re-evaluated on every spawn-like action.** The effective flag for any launch — create, resume, migrate, or hand-off — is `requested ∧ profile gate ∧ target account opt-in`, evaluated at that moment. A session that ran without prompts does not carry the flag through a resume after the gate was closed, and a migration or hand-off never inherits it onto an account that hasn't opted in; the session continues with prompts on (and says so in the terminal).

Turning the gate off later immediately hides the toggles; already-running sessions are unaffected but are badged so it's visible which live sessions are running without prompts.

### Prompt bank

Each profile owns an editable collection of plaintext prompts — the snippets you find yourself retyping across agents ("write tests for what you just changed, then run them", "summarise the diff against base as a PR description", review checklists, house style rules).

- **Always available everywhere.** A prompt's optional `tags`, `project`, and `agent` associations are **ranking hints, never filters**: the picker boosts prompts associated with the current project/agent to the top, but every prompt is reachable from any session of any agent in any project. Default ordering: match quality, then frecency (`use_count` + `last_used_at`).
- **Insert flow**: from a focused terminal, one action (⌘K → "Insert prompt", plus a dedicated shortcut, e.g. ⌘⇧P) opens a cmdk-style picker with fuzzy search over title/body/tags and a preview pane; selecting **pastes the body into the terminal's stdin without submitting** — wrapped in bracketed-paste sequences (`ESC[200~ … ESC[201~`), because a raw multi-line write would let each newline submit a partial prompt to the agent. The text can then be edited or prefixed before sending. The same picker is available inside the new-session modal's prompt field.
- **Management**: a "Prompts" section in the settings panel — plain list, inline textarea editing, tag chips, optional project/agent association dropdowns, delete with an undo toast. Creating a prompt from the picker ("save current input as prompt…") keeps capture frictionless.
- **v1 is literal plaintext**: no templating variables, no sharing between profiles (a coworker's bank is theirs; copy-paste is the sharing mechanism). Both are possible later; neither should complicate v1.

**Projects are the workspace unit.** A project belongs to one profile and one repo, and owns a set of sessions plus persisted UI state. The dashboard (`/`) lists the current profile's projects only — there is no cross-profile view (decision 2026-07-13); day-to-day work happens inside `/project/:id`. New sessions are always created within a project, which supplies the profile, repo, and defaults — so the new-session modal reduces to account → base branch (with a ticked-by-default "use separate branch" toggle; unticking hides the Branch field and warns — §4 Relaxed isolation) → title/prompt. Session branches default to `<branch_prefix><slug(title)>` (or the session's short id when untitled); on collision with any existing branch, append `-2`, `-3`, … — never fail session creation on a branch-name clash.

**Reload semantics.** Workspace layout is a two-tier model (decision 2026-07-14, refining the earlier single-row design below). Each **window** keeps its own working set in `sessionStorage` (`puddle.ws.<project>.<profile>`) — reloading that window restores it exactly, independent of any other open window, and windows never live-sync while open. The `(project, profile)` row in `project_states` — layout follows identity, not browser (decision 2026-07-13; replaces the earlier client-uuid keying so layouts survive tunnel-port and machine changes) — remains the **seed for fresh windows**: a window with no sessionStorage entry yet (a new tab, a fresh browser, a different machine or tunnel port) loads from that row instead. The snapshot JSON holds: open session tabs and their order, per-session view state (pane split, open editor `(session, path)` tabs, explorer pin), active session, layout sizes. Consequences:

- A window's own reload or browser restart restores that exact window, from its own sessionStorage entry.
- A brand-new window has no sessionStorage entry, so it seeds from the project's most recently written server row.
- Any number of your own windows on the same project each keep an independent working set — they never live-sync — and the server row is updated debounced (~2 s), last-writer-wins, by whichever window changed layout most recently; this only affects what a _future_ fresh window seeds from, never an already-open one.
- A coworker peeking works under their own profile: they seed from the project's most recent snapshot but their rearrangements are written to _their_ row — they can never clobber yours.
- Stale rows (not updated in 90 days) are garbage-collected by the daemon.

Transient focus (which tab is active right now) stays local to the window.

Dirty editor buffers persist independently in the browser's IndexedDB (`puddle-drafts`, debounced ~1 s) and are restored on reload; drafts are per-browser only, never synced through the daemon or between windows.

Any profile can view/attach any session (trusted shared box); the UI shows the owning profile on each project and session card.

## 12. Design system

Puddle's UI must read as a polished, intentional developer cockpit — dense, calm, and visually coherent — not a scaffold of framework defaults. `HUMANS.md` at the repo root is the human-authored design brief (minimalism, no boxes/borders, fill-shift responsiveness, secondary hints on their own line, sentence case) and overrides this section wherever they conflict.

- **Stack**: Tailwind CSS v4 + **shadcn/ui** (Radix primitives, generated into `packages/web/src/components/ui/` and treated as owned code to restyle, not a dependency), `lucide-react` icons, `cmdk` command palette (⌘K: switch project/session, new session, open file, insert prompt, switch theme, open settings), `sonner` for toasts, `react-resizable-panels` for the workspace layout. No monolithic kits (MUI, Ant): they resist theming and read as generic enterprise chrome.

- **Two-layer token architecture** in `packages/web/src/styles/tokens.css`:
  1. _Primitive palette_: theme-independent colour ramps derived from the five core colours below.
  2. _Semantic tokens_: the only names components may use — `--bg-base`, `--bg-surface`, `--bg-elevated`, `--border`, `--text-primary/-secondary/-muted`, `--accent`, `--accent-hover`, `--action`, `--action-hover`, `--action-ink`, `--focus-ring`, `--danger`, `--status-running/-waiting/-interrupted/-idle`, `--selection`, `--diff-added`, `--diff-removed`, plus the 16 `--ansi-*` terminal colours. A theme is one `[data-theme="<name>"]` block assigning primitives to **every** semantic token.

  The Tailwind theme maps utilities onto semantic tokens; the xterm.js theme object and the Monaco theme are **generated at runtime from the computed CSS variables**, so adding a theme is one CSS block plus one entry in a theme registry — zero TypeScript changes. A CI script asserts each theme block defines the complete semantic set and that text pairings pass WCAG AA (4.5:1 body, 3:1 large/UI elements). Terminal, editor, and chrome must visibly share one palette — a stock-dark xterm next to Monaco's default `vs-dark` inside a differently-dark app is forbidden.

- **Core palette** (the brand; hue is preserved within each ramp, only lightness/saturation step):

  ```css
  --altitude-blue: #7dadff; /* primary accent family */
  --krypton-green: #8be8b3; /* success / running family */
  --quiet-khaki: #ddb28c; /* warm neutral / attention family */
  --storm-navy: #001c3d; /* dark ground / light-theme ink */
  --burnt-wood: #5a2f22; /* warm ink / danger family root */
  ```

  Extended ramps: navy `#000A14 · #00132B · #001C3D · #0A2B52 · #163C6B`; blue `#A7C7FF · #7DADFF · #4A86E8 · #2E6BD6`; green `#8BE8B3 · #1FA26B`; khaki `#FBF5EC · #F7EBDA · #EAD9C0 · #DDB28C · #F0B36E · #A9743D`; wood/ember `#F2957C · #C2472E · #8C4A34 · #5A2F22`; mist (cool text ramp for dark ground) `#EAF1FB · #B9C9E0 · #7E93B3`; tertiary pastels completing the ANSI set at the core pastels' lightness: cyan `#7FD6DC` (blue×green), violet `#B9A3F2`.

- **Themes**: v1 ships `dark` (default) and `light`, plus a "system" option following `prefers-color-scheme`; switchable in settings and via ⌘K. Semantic assignments:

  | semantic token                      | dark      | light     |
  | ----------------------------------- | --------- | --------- |
  | `--bg-base`                         | `#000A14` | `#FFFFFF` |
  | `--bg-surface`                      | `#00132B` | `#F7F7F7` |
  | `--bg-elevated`                     | `#001C3D` | `#EFEFEF` |
  | `--border`                          | `#163C6B` | `#E5E5E5` |
  | `--text-primary`                    | `#EAF1FB` | `#001C3D` |
  | `--text-secondary`                  | `#B9C9E0` | `#163C6B` |
  | `--text-muted`                      | `#7E93B3` | `#8A7663` |
  | `--accent` / `--focus-ring`         | `#7DADFF` | `#2E6BD6` |
  | `--accent-hover`                    | `#A7C7FF` | `#4A86E8` |
  | `--action` (primary-button fill)    | `#EAF1FB` | `#001C3D` |
  | `--action-hover`                    | `#B9C9E0` | `#0A2B52` |
  | `--action-ink` (text on the fill)   | `#001C3D` | `#FFFFFF` |
  | `--status-running`                  | `#8BE8B3` | `#157A50` |
  | `--status-waiting`                  | `#F0B36E` | `#A9743D` |
  | `--status-interrupted` / `--danger` | `#F2957C` | `#C2472E` |
  | `--status-idle`                     | `#7E93B3` | `#8A7663` |

  Primary actions (buttons, checked toggles) are **ink, not accent**: mist on the dark theme, storm navy on the light — the accent blue is reserved for links, focus, and selection. The dark theme is storm-navy ground with the pastel family as light; the light theme is a white ground (HUMANS.md: white, not beige) with navy ink for primary and secondary text and golden bark for muted, keeping the deep accent steps. Light `--status-running` uses a derived deeper krypton step (`#157A50`) because `#1FA26B` misses the 3:1 AA floor on the elevated ground.

- **ANSI mapping rule**: dark theme maps the pastel depth of each hue (red→`#F2957C`, green→`#8BE8B3`, yellow→`#F0B36E`, blue→`#7DADFF`, magenta→`#B9A3F2`, cyan→`#7FD6DC`, fg→`#EAF1FB`) over `--bg-base`; the light theme maps each hue's deep step (`#C2472E`, `#1FA26B`, `#A9743D`, `#2E6BD6`, …) so agent output stays legible on the white ground. Brights are one lightness step up. UI accents and terminal output are thereby the same family by construction.

- **Type**: one UI face and one mono face, chosen deliberately and **self-hosted** (hosts and clients may be offline; no font CDNs). Mono is the workhorse of identity: session titles, branches, the powering account's label, paths, ports, and statuses are all set in mono. Set a real type scale.

- **Signature element — status ripples**: a session's status indicator is a small dot that, while the agent is working, emits a slow concentric ripple in `--status-running` (the puddle motif); `waiting_input` shifts it to a pulsing `--status-waiting`, mirrored in the tab title/favicon. This is the interface's one animated flourish. Everything else is instant or a ≤150 ms fade; `prefers-reduced-motion` degrades the ripple to a static dot.

- **Density**: compact paddings, information-dense lists, tabular numerals for ports/counts; generosity is reserved for primary actions and empty states.

- **Quality floor**: visible keyboard focus everywhere (`--focus-ring`); session tabs, palette, and explorer fully keyboard-navigable; empty states direct action ("No sessions yet — press ⌘K to start one"); error copy states cause and fix, never apologises vaguely.

## 13. Repository conventions

- Monorepo (pnpm workspaces): `packages/daemon`, `packages/web`, `packages/cli`, `packages/shared` (zod schemas + WS message types shared by all three).
- TypeScript strict everywhere; vitest for tests; eslint + prettier; MIT licence.
- `CLAUDE.md` at the repo root governs agent conduct and links `CHANGELOG.md`; see those files. Archived changelogs live in `docs/changelogs/CHANGELOG-vX.Y.Z.md`.
- **Licensing rule**: this is a public MIT repo. Do not copy code from AGPL projects (e.g. claude-squad) — studying their approach to worktree/PTY edge cases is fine; verbatim or near-verbatim code is not.
- No company-, team-, or person-specific strings anywhere.

## 14. Phases and acceptance tests

Each phase must be independently verifiable before the next starts.

- **Phase 0 — scaffold.** Monorepo, CI (typecheck + test + build), CLAUDE.md/CHANGELOG.md conventions in place. AT: `pnpm build` produces daemon with embedded UI assets; CI green.
- **Phase 1 — daemon core.** Profiles/accounts/repos/projects/sessions CRUD; local-security layer (token, Host/Origin checks — §2); permissions-gate enforcement; claude-code adapter; worktree create/remove (per-repo mutex, fetch policy, onboarding preamble injection from onboarding_notes + marker-file notes sync); PTY spawn with `CLAUDE_CONFIG_DIR`; WS streaming; append-only logs; reconcile pass. AT: via curl + wscat only — two sessions on two accounts stream interleaved output; requests without the token are rejected; `skip_permissions: true` against a closed gate returns 400; `systemctl --user restart puddled` marks sessions interrupted; resume restores both conversations; logs replay; a session on a fresh worktree receives the onboarding preamble (and a hand-off session in the same worktree does not); writing `.puddle/onboarding-notes.md` updates `repos.onboarding_notes`.
- **Phase 2 — UI shell.** Design system foundation first (tokens.css with both themes + registry, CI token/contrast check, Tailwind + shadcn setup, fonts, runtime-generated xterm/Monaco themes — §12), then: project dashboard; project workspace with session tabs and live status ripples; terminal attach with replay; new-session modal (account → base branch → title/prompt); interrupted-session resume button; theme switcher; **settings panel** (all §11 sections; permissions gate with its confirm dialogue); ui_state persistence and restore-on-open (AT: open a project with three sessions and two editor tabs, kill the browser, reopen `/project/:id` — identical workspace; AT: switching theme restyles chrome, terminal, and editor together with no reload).
- **Phase 3 — files, diff, history.** Tree browser, Monaco editing, diff tab (editable modified side), history tab; file transfer (drag-in upload onto explorer folders, context-menu download with zipped folders — §8). AT: edit a file in the diff view; the agent's next `cat` of it shows the change; commit list matches `git log`; drag a file from the local desktop onto an explorer folder — it appears in the worktree; download a folder — a zip of its contents arrives.
- **Phase 4 — terminal links.** URL addon, file-path link provider with resolve validation, open-in-editor deep links. AT: cmd+click on `src/x.ts:42` in agent output opens Monaco at line 42.
- **Phase 5 — ports.** Detection table + copyable `ssh -L`; then tier-2 proxy with WS upgrade. AT: a Vite dev server started by an agent is usable through `/proxy/...` including HMR.
- **Phase 6 — CLI.** `puddle connect` bootstrap/upgrade/tunnel/browser; `attach`, `status`, `logs`; **the serving switch**: the CLI serves the UI at a stable local origin and proxies `/api` + `/ws` (local and SSH modes alike — §2), the daemon build stops embedding web assets and its default binding moves to `127.0.0.1:7434`, and the protocol handshake with automatic major-mismatch daemon update goes live (§6). AT: on a box with no puddle installed, one `puddle connect user@host` lands in a working cockpit at `http://localhost:7433`; `puddle start` locally lands in the same cockpit at the same origin; against a daemon with an older protocol major, `connect` updates it automatically, prints the interrupted-session count, and the sessions resume.
- **Phase 7 — more agents + continuation.** codex and opencode adapters, capability matrix verified against installed versions, degradation paths exercised; account migration and cross-agent hand-off (AT: exhaust-simulate a claude session, migrate it to a second claude account — conversation resumes with history intact; hand off a claude session to codex — new session in the same worktree opens with the transcript summary as its first prompt).
- **Phase 8 — polish.** **Prompt bank** (CRUD, picker, insert-into-terminal; AT: save a prompt tagged to project A, insert it from a codex session in project B — it still appears in the picker, ranked lower, and pastes without submitting); waiting_input notifications (title badge + optional sound), archive/cleanup flows, log rotation (size cap from config.json), shell tabs.

## 15. Open questions (resolve during build, record decisions in CLAUDE.md)

1. Exact resume/session flags for the installed codex and opencode versions (verify with `--help`; pin findings in each adapter with the version checked).
2. Session-file portability between accounts (tier-1 migration): verify per agent version that a conversation file moved between config dirs resumes cleanly; pin the verified version in the adapter and keep the rollback-to-hand-off path tested.
3. Whether `claude --session-id` is accepted by the currently installed Claude Code version; if not, fall back to post-launch discovery of the newest JSONL in `<config_dir>/projects/<cwd>/`.
4. systemd user-session availability on the target box (`loginctl enable-linger`); confirm the fallback supervisor path works.
5. Proxy base-path limitation: decide whether to attempt HTML rewriting (probably not for v1) or document the `ssh -L` fallback per port.
6. Multi-host UI (post-Phase 6): whether one CLI process can serve several host connections from a single origin (path-per-host routing, e.g. `/h/<host>/…`) instead of one origin per `connect`. The CLI-serves-UI architecture (§2) leaves this open; one-origin-per-connect is the v1 answer.
