# Puddle — Specification

Puddle is a self-hosted **orchestrator for CLI coding agents** (Claude Code, Codex, OpenCode, and others) — run many agents in parallel, each isolated in its own git worktree, managed from one workspace UI. On the machine hosting the work, the daemon owns worktrees and application state, while one independent `puddler` per runtime owns agent and shell processes. On your own machine, `puddle launch` gives you the cockpit at `localhost`. On a remote box, **first-class SSH support** (`puddle launch user@host`) bootstraps the daemon and reaches the same cockpit over a single tunnel, in the spirit of VS Code Remote-SSH: live agent terminals, file editing, diff review, git history, and port forwarding. Under systemd/launchd, independent runtimes keep running across cockpit disconnects and daemon replacement. Machine reboot loses live process state; saved native conversations can resume according to host settings. An SSH host that reaps detached daemons gets a cockpit-held daemon instead: closing it detaches independent host-session owners, which may survive or be reaped by host policy. Reconnection adopts survivors and reconciles ended owners (§10).

Puddle is a public, general-purpose tool. Nothing in the codebase, docs, examples, or default configuration may reference any specific company, team, or person. Use generic placeholders (`alice`, `user@devbox`, `my-repo`).

## 1. Goals and non-goals

Goals:

- Run many coding-agent sessions in parallel on one host machine — your own laptop/workstation (local mode) or a remote box (SSH mode) — each isolated in its own git worktree and branch by default (sessions can opt out of branch isolation and share — §4 "Relaxed isolation"). Both modes use the identical daemon and UI; SSH mode only adds bootstrap and a tunnel.
- Support multiple **profiles** (one per collaborator on a shared box) and, within each profile, multiple **accounts** per agent type (separate credential/config dirs), with any number of concurrent sessions per account.
- Organise work into **projects** (profile + repo + sessions + persisted UI state): a window attaches to one project, multiple windows can open the same project, and reloading a window restores the project exactly — open sessions, terminals (via log replay), and editor tabs.
- Full persistence: accounts, sessions, branches, and terminal history survive daemon restarts, SSH disconnects, and machine reboots.
- A browser UI with: session sidebar with live status, xterm.js terminals (agent + shell tabs), Monaco file viewing/editing, diff review against the base branch, git history browsing, detected-port list with forwarding, and clickable file paths / URLs in terminals.
- One-command startup: `puddle launch` locally, `puddle launch user@host` for a remote box.
- Agent-agnostic core with per-agent adapters; adding an agent means adding one adapter module.
- A **Scratchpad**: a per-profile bank of reusable prompts and free-form notes, a floating panel opened from the top bar. Each entry is either project-scoped (shown only in that project) or profile-scoped (shown everywhere in the profile); entries are drag-reorderable, filterable by tag or agent, editable inline, and insertable into the focused session in one action.
- **Saved layouts**: named snapshots of the workspace's tiling layout, saved and loaded from a top-bar Layouts popover in the Scratchpad's mould. Each is profile- or project-scoped, following the project-based-layout setting at save time; loading one whose scope disagrees with that setting flips the setting as part of the load, without erasing any stored per-project layout.

Non-goals (v1):

- User authentication/authorisation. Puddle assumes a single trusted OS user; local profiles are organisational identities. Remote registrations restrict application access to one profile but do not isolate OS-level execution or files. (This is distinct from the mandatory browser-facing token in §2 "Local security", which defends the localhost API against malicious web pages, not against local users.)
- Merge automation, PR creation, or conflict resolution.
- Replacing a full IDE. Deep editing happens via "Open in editor" deep links; Monaco covers review and quick edits.
- Multi-machine fleets. One daemon per box; `puddle launch` targets one host at a time. (Keep the CLI's host handling clean so this can grow later.)
- Native Windows hosts. v1 host platforms are Linux and macOS; Windows users are served via WSL2 (which behaves as a Linux host). The client side (browser + CLI tunnel) works from any OS.

## 2. Architecture

```
 client machine                                   host machine (local or remote)
┌──────────────────────────────┐                 ┌───────────────────────────────────┐
│ browser ── localhost:7433    │                 │  puddled  (supervised/SSH-held)   │
│               │              │  local: direct  │   ├─ REST + WS API (Hono)         │
│  puddle CLI ◄─┘              │  remote: ssh -L │   ├─ runtime controller          │
│   ├─ static web UI assets    │────────────────►│   ├─ worktree manager (git CLI)   │
│   └─ /api + /ws proxy        │    HTTP + WS    │   ├─ agent adapters (per agent)   │
└──────────────────────────────┘                 │   ├─ SQLite (source of truth)     │
                                                 │   └─ daemon-owned execution       │
                                                 └───────────────────────────────────┘
                                                               │ private runtime IPC
                                                 ┌───────────────────────────────────┐
                                                 │ puddler (one service per runtime) │
                                                 │  PTYs, provider sidecars, journals│
                                                 │  output, screens and environment  │
                                                 └───────────────────────────────────┘
```

**The CLI serves the UI; the daemon is a headless API server.** In both local mode (`puddle launch`) and SSH mode (`puddle launch user@host`) the browser talks to one stable local origin — `http://localhost:7433`, served by the `puddle` CLI — and the CLI reverse-proxies `/api` and `/ws` to the daemon: directly to `127.0.0.1:7434` locally, through the SSH tunnel remotely. One serving path for both modes, no CORS (single origin), and no host- or tunnel-port detail ever reaches the browser. The daemon is host-agnostic: it binds `127.0.0.1:7434` and neither knows nor cares where the client is. UI updates ship with the CLI — updating the CLI once updates the cockpit for every host it connects to; the daemon is only forced to update when the protocol breaks (§6 Protocol versioning).

- **`puddled`** (daemon): Node 22 LTS — pinned, and shipped inside the release tarball, so the choice never depends on the host. Hono for HTTP, `node-pty` for terminals, `better-sqlite3` for state; both are native modules and ship prebuilt in the tarball. API only — no web assets. Binds `127.0.0.1:7434` by default (installs that predate the serving switch are migrated off the old 7433 default once, via a file-only `configVersion` marker in `config.json`). If that preferred port is already in use the daemon **falls back to an OS-assigned free port instead of crashing**, and records wherever it actually bound in `~/.puddle/runtime.json` so clients can still find it (§10); every start prefers `config.json`'s port, so the daemon returns to it as soon as the conflict clears. (Bun is fine as dev tooling; the daemon itself runs on the pinned Node.)
- **Web UI**: React + TypeScript, xterm.js (+ fit, web-links addons), Monaco (`@monaco-editor/react`). Built to static assets shipped inside both the standalone CLI archive and npm package (`@puddle-code/cli`).
- **UI-only development preview:** `pnpm --filter @puddle/web dev:preview` serves the real React cockpit at localhost:5174 with an isolated sample profile/project and browser-memory files. Vite mode `ui-preview` omits the authenticated host gateway entirely. Its development-only entry installs fixture requests and an inert socket; unimplemented operations return an explicit preview-unavailable response. It never starts a daemon, reads host files or relaxes production authentication/protocol checks. Sample file saves last until reload; normal appearance settings remain available. Production builds exclude the preview entry and fixtures.
- **`puddler`** (runtime owner): one independent process per live agent or terminal runtime, pinned to its launch release. Its PTYs, provider sidecars and retained observations survive daemon replacement. Login terminals, notebooks and other daemon-owned execution retain their separate lifecycles.
- **`puddle` CLI** (client machine): standalone archive with a pinned Node runtime, or optional npm package; bootstraps/updates the daemon (locally or over SSH), serves the web UI and proxies `/api` + `/ws` to the daemon, opens the tunnel when remote, launches the browser, and performs the protocol handshake (§6) on every start/connect.
- **State layout on the host**, all under `~/.puddle/`:

```
~/.puddle/
├── puddle.db                 # SQLite
├── token                     # host-only authority + atomic migration version (0600)
├── browser-authority/        # cockpit browser/proxy verifiers, scoped by target and origin
├── config.json               # daemon settings: PREFERRED port, log caps
├── runtime.json              # live port the daemon ACTUALLY bound + pid; written on bind, removed on clean shutdown (§10)
├── supervisor                # install.sh's selected lifetime: systemd | launchd | nohup | none (§10)
├── puddled.pid               # nohup or SSH-attached daemon pid used by bootstrap/removal lifecycle
├── profiles/<profile_id>/accounts/<agent_type>/<label>/   # per-account agent config dirs (created by puddle; id-keyed — names are display labels)
├── profiles/<profile_id>/sessions/<agent_type>/<store-key>/   # shared conversation store: canonical adopted conversation dirs, symlinked into each account (§5)
├── remote/profiles/<profile_id>/       # independent remote registration, identity, grants and retirement retries
├── worktrees/<repo_id>/<session-id>/   # repo_id, not repo name — names can collide
│                      /branch-<slug>/  # shared worktrees for separate_branch = false sessions (§4)
├── logs/<session-id>/<term>.log        # append-only PTY output, one file per terminal (agent.log, shell-1.log, …)
├── logs/<session-id>/<term>.terminal.json # atomic headless-xterm screen + scrollback snapshot for attach (§6)
├── cockpits/<target>.json              # CLIENT side: registry of running cockpit processes (§10 puddle list/kill)
└── logs/cockpit-<target>.log           # CLIENT side: a background cockpit's own output
```

Puddle NEVER mutates or adopts agent config directories it did not create (e.g. an existing `~/.claude` or `~/.codex`). Every puddle-managed account gets a fresh directory under its profile's subtree, populated either by puddle's login flow or by **import**: `POST /api/accounts {import_dir}` COPIES a pre-existing config dir into the new puddle-owned dir, byte-for-byte and read-only — the source is never touched again, nothing is parsed beyond the agent's own state file, and the account's logged-in flag is set by asking the agent (adapter `checkLoggedIn`), never assumed (macOS keychains bind OAuth tokens to the source path, so credentials may not travel with a copy). This keeps puddle state disjoint from whatever else runs on the box.

**Puddle never reads agent-account credentials — no exceptions.** Subscription rate-limit usage (the profile panel's progress bars) is fetched by asking the agent's own CLI (for claude-code: `claude -p /usage`, print mode, run with the account's config dir), so the agent authenticates itself exactly as an interactive session would and puddle touches no tokens. Results are cached per account in the daemon (each fetch spawns a process) and every failure — logged-out account, missing binary, timeout, unrecognised output — yields no data rather than wrong numbers. The desktop's client-side SSH askpass bridge (§10) is distinct: it transiently relays a response from its authentication dialogue to the local system `ssh` process, but never logs, stores, or sends that response to puddled.

**Accounts are strictly per-profile.** The API never lists, attaches, or spawns with another profile's accounts; the UI's account picker shows only the active profile's. If a collaborator wants to use "your" underlying agent subscription, they log in again under their own profile, producing an independent config dir. Note this is organisational isolation, not security — everything runs as one OS user, so anyone with shell access can read any directory; the goal is preventing accidental credential sharing and history mixing, not defending against a malicious housemate.

### Storage exhaustion

Terminal logging is best-effort: opening, flushing, rotation and closing cannot
interrupt live PTY delivery. Unsaved output retains at most 256 KiB per terminal
and 8 MiB across the daemon, discarding oldest history when full. Retries back off
from one to thirty seconds; successful partial writes are never duplicated.
Snapshot failures retain live emulators, clean temporary files and back off too.
History dropped during an outage cannot be recovered after restart.

Inactive bulk terminal logs default to three days of retention (`logRetentionDays`,
25.6; zero disables age-based cleanup). Startup and hourly sweeps atomically compact
older logs to the full configured replay tail (256 KiB by default), preserving
canonical screen/scrollback snapshots, shell histories and terminal ids. This keeps
archived restoration and hand-off fallback byte-for-byte unchanged, including older
terminals with no snapshot. Active/open logs, changed files and symlinks are skipped;
copies use bounded buffers and leave the original intact on failure. Root diagnostic
logs belong to other processes and are outside this policy. Retention follows settings
on the next sweep; an increased replay window cannot recover previously discarded
bulk output. Native conversations, worktrees and SQLite records are never swept.

SQLite capacity errors return HTTP 507 `storage_full`; failed user operations and
native conversation switches are never automatically replayed. Background runtime
status and exit observations stay in a bounded, coalesced queue (4,096 placements),
with optional `persistence_pending` on session reads until saved. PTY exit cleanup
still releases runtime ownership. Other failed metadata observations are best-effort;
SQLite remains the durable source of truth. Database recovery requires a successful
write probe and saving queued runtime observations. Full-disk boot recovery remains
separate: initialisation still requires writable authority and database storage.

The daemon asynchronously polls Puddle home, logs, worktrees, temporary storage,
registered repositories, active placement directories and account directories every
30 seconds. Available bytes below 1 GiB or available inodes below 10,000 warn; below
256 MiB or 1,000 inodes blocks new sessions/resumes and worktrees. Filesystems without
an inode limit omit that metric. Admission rechecks the actual destination paths;
an unavailable probe refuses admission rather than assuming space is available.
Checks are advisory: the write error remains authoritative for quotas and races.

Local/SSH cockpits poll GET `/api/storage` (25.5) and show a persistent, borderless
warning until recovery, including affected paths and available space/inodes. The
endpoint requires existing browser/host authority and remains denied to remote
profile leases and the connector because it includes host-wide paths. Configuration
and host GETs never rewrite configuration. No storage cleanup deletes user work.

### Local security (mandatory, Phase 1)

Binding to `127.0.0.1` is **not** protection from the web: any website open in the user's browser can attempt `fetch("http://localhost:7433/...")`, and DNS-rebinding can defeat naive same-origin assumptions. For a daemon that can spawn agents with permissions skipped, an unauthenticated localhost API is a remote-code-execution vector via CSRF. Therefore, from Phase 1:

1. **Host authority (protocol 18.0)**: an owner-only Unix socket in a short private runtime directory admits local clients and a bundled host-side SSH helper. Ownership, permissions and stale-socket liveness are checked before use. Before reading configuration or opening authority IPC, the daemon and clients initialise the Puddle home privately: owned legacy directories with group/other read or execute permissions (such as `0755`) migrate to `0700`, without recursively changing stored data. Symlinked, foreign-owned and group/other-writable homes are rejected; existing authority files and runtime subdirectories retain strict permission checks. The host master credential stays on the host; `~/.puddle/token` atomically stores its replacement and migration version together. The protocol-18 daemon never accepts the previously distributed master on its data paths. Upgrading stops legacy connections; subsequent starts do not repeat migration.
2. **Connection leases**: the daemon retains hashes of random 256-bit connection tokens in memory. A dedicated control channel participates every 15 seconds; the lease expires after 45 seconds without participation. Tokens rotate every 30 seconds and have an absolute 60-second lifetime. Data-token possession cannot issue or renew authority. Control closure revokes immediately; monotonic deadlines bound silent partitions. Each streaming HTTP request or WebSocket has a unique client-generated resource identifier, explicitly included in control renewals. Duplicate identifiers are rejected; an attacker opening a stream with a stolen token cannot inherit legitimate renewal. Dispatch and streaming checks enforce deadlines even when timers run late. Revocation closes dependent connections without stopping daemon-owned agents.
3. **Browser authorisation**: `puddle launch` obtains a single-use, five-minute `#invite=` invitation through protected local launcher IPC (owner-only Unix socket, authenticated named pipe on Windows clients). The page clears the fragment immediately and exchanges it for an origin-scoped localStorage credential accepted only by its cockpit. Private, atomically written cockpit state retains only verifiers and target/origin scope, with 30-day inactivity expiry. Login survives cockpit replacement and crashes; closing a tab leaves siblings authorised. Independent browser authorisations can be revoked separately. Registry records contain no credentials; internal refreshes and background logs never print invitations. `--no-browser` returns an invitation only to its requesting launcher. Old `puddle.token` storage and `#token=` fragments are removed without conversion; existing tabs ask the user to run `puddle launch` once.
4. **Browser gateway**: the cockpit requires its exact `localhost:<port>` Host and browser Origin on authentication/control boundaries, rejecting foreign and null origins. It authenticates browser requests, strips supplied upstream credentials and adds its current connection authority. The main WebSocket is an authenticated bridge and reports connected only after the daemon acknowledges authentication. Browser rejection is distinct from upstream expiry, unavailability and protocol mismatch; an upstream failure never clears browser login. Vite uses the same gateway. Static cockpit assets are public.
5. **Forwarded applications**: cockpit content is served only on `localhost`, applications only on `127.0.0.1` at the same port. Reusable `/forward/:sid/:port` links open a trusted cockpit landing page, obtain a target-scoped invitation, and exchange it on the application origin for a host-only, HttpOnly, SameSite=Strict, path-scoped cookie. Desktop terminal links and port chips obtain this application-scoped invitation in the authorised cockpit before handing it to the system browser, whose storage is separate from Electron; browser cockpits continue to open the reusable landing page synchronously. Only its verifier is persisted, bound to browser authorisation; every request also requires current upstream authority. Detected-port restrictions remain mandatory. Puddle credentials are stripped before forwarding; application headers, cookies, HTTP and WebSockets are preserved. Application content never executes at the cockpit origin; HTML previews retain their existing sandbox.

Self-hosted mobile access uses an outbound connector and a separately served trusted browser application, with Better Auth service login and independently approved host device identities. Noise XX carries application messages through an opaque relay; host authority continues to use protocol 18.0 leases. Remote protocol 5 is independent. There is no default hosted service or provider tunnel. See [mobile design](docs/roadmap/mobile-access.md), [deployment](docs/mobile-access.md) and [acceptance](docs/acceptance/mobile-access.md).

Service login uses Google and/or GitHub OAuth only; at least one complete provider configuration is required. Better Auth owns the OAuth state, callback and cookie flows. A current provider-verified email is required at every sign-in; account registration is open to everyone through the configured providers, with no signup allowlist or registration switch. New accounts have no access to another account's hosts, and host access still requires exact browser approval. The example Caddy deployment manages HTTPS without an email contact setting. Puddle has no email/password login, email delivery or password recovery. The public authentication surface allowlists social sign-in, provider callbacks, session inspection/sign-out and optional authenticator MFA enrolment/verification/recovery codes. Passwordless MFA still gates host registration and relay admission. Different provider identities are never linked implicitly by matching email; account recovery belongs to the original provider. Startup retires legacy password credentials and all existing service sessions/challenges when such credentials are present, preserving provider bindings and host ownership. Email-only accounts require fresh service registration through local/SSH host control. Removing email login and changing the cockpit pairing invitation contract bumps remote protocol to 2 and daemon/cockpit protocol to 19.0; the host lease semantics are unchanged.

### Why no tmux

Each live runtime has one independent `puddler` owner for its PTYs, output and provider sidecars. The daemon owns application state and adopts those owners after replacement. tmux would duplicate that role with a second session registry that can drift. The "attach from a raw terminal" escape hatch tmux provided is replaced by `puddle attach <session>` (CLI → daemon WebSocket).

### Persistent runtimes (0.4.0)

Application protocol remains 26.1: its major already requires an approved upgrade
from released protocol-25 daemons. Cockpit, daemon and runtime installations show
the corresponding component sections of the release notes in a read-only Markdown
preview. Release content ships with the software: the cockpit embeds its exact
release, and authenticated `GET /api/release-notes` returns the running daemon and
selected runtime's bounded documents. No release-service request is needed to read
them. Missing older documents are omitted rather than borrowed from another build.
The remote read-only allowlist carries the same public content without granting
maintenance authority. Presentation remembers rendered component/version notes per
browser and host, merges matching releases and serialises different releases;
staged targets never count as installed software.

Managed runtime memory has one durable host ceiling, initialised to a quarter of
physical memory (or a lower reported process constraint), capped at 8 GiB. Its
private sealed ledger survives daemon replacement and retains the original
capacity. Launch admission reserves essential state before dispatch; each owner
shares its cached grant across terminal history/screens, checkpoint work, transport
and provider bridge buffers. Idle spare returns use bounded retries. New launches
can be refused without stopping existing runtimes. Exact retirement reclaims a
grant only after its process-memory claim is free and its launch is durably fenced;
graceful execution shutdown alone cannot release that claim. These limits account
for Puddle-managed capacity, not native-agent allocations, total process RSS or a
physical filesystem quota.

Snapshot restoration opens and validates a saved file before reserving its read
workspace; a new terminal with no saved file needs no restore reservation. Already
charged parser work and snapshot waiters can yield for up to five seconds while a
grant change remains unresolved, rechecking local capacity and the same durable
grant before spending. Definitive exhaustion still refuses admission. This neither
replays terminal input nor expands the existing work queues or memory limits.

Concurrent canonical-screen readers share one pending serialisation only at the
same ordered input boundary. Each reader retains its own bounded metadata
admission and transfers ownership within the existing snapshot work allowance.
Queued output or geometry changes require a separate capture; repeated requests
for the same queued geometry do not add parser work. Captures retain no ANSI
cache after hand-off. Periodic persistence, fsync and shutdown flushing retain
their existing cadence and capacity checks.

Runtime owners admit canonical viewport and initial parser-action capacity before
creating a native PTY, then await restore and requested geometry. A refusal prevents
the new terminal from starting with a canonical-screen gap. Preparations coalesce
per terminal, are bounded to 32 metadata entries and are cancelled by release,
forgetting or shutdown. Owners fence competing launches of the same terminal and
recheck the exact controller, socket and placement after preparation, immediately
before native dispatch. Failed dispatch releases the unused prepared screen after
queued work settles. Legacy synchronous PTY interfaces remain for their existing
callers; they are not the independent runtime launch path.

The Codex native bridge pauses unsent traffic when its shared allowance is
unavailable, preserving the native CLI and sidecar. Raw fragments, parsed metadata
and deferred forwards retain their charges through delivery; control-frame replies
own only their small copied payloads. Native messages retain their existing 100 MiB
ceiling independently of runtime IPC traversal limits. Scripted turns separately
admit retained early events and bound diagnostic/turn identifiers. Accepted writes
are never replayed, and uncertain lifecycle delivery disables full synchronisation
and scripted control rather than inventing a successful observation.

Persistent runtimes and cockpit-managed host updates are required standard behaviour
from 0.4.0, without an enable/disable setting or selectable legacy backend. The
production paths described below are implemented; native provider, platform,
reboot and remaining acceptance evidence is tracked in the
[persistent-runtime acceptance script](docs/acceptance/persistent-runtimes.md).
Native Linux execution and the remaining real-provider, interactive desktop,
native installed-service, SSH/logout and actual reboot/purge checks are deferred
as manual release acceptance by the user's explicit verification decisions.
Available automated checks still apply; no native pass is inferred. Daemon composition uses
the installed independent runtime for terminals and interactive/headless agents.
Only internal fixtures can select the legacy in-process backend. Each launch probes
the host user service manager through the same inspection used by update preflight,
then pins the runtime selector before recording intent. An invalid installation
never falls back to daemon-owned PTYs. When the manager is unavailable, an owned
`nohup`/`none` installation marker permits one detached owner with an explicitly
limited host-session lifetime. Its private intent precedes dispatch, its own process
group is checked before any provider/PTY starts, and authenticated adoption proves
readiness. During launch, only an attached owner's explicit `prepared` state may
be rechecked ahead of ordinary reconciliation backoff. Storage, transport and
adoption failures retain recovery backoff; maintenance admission and the committed
binding, terminal and journal checks still gate readiness. A failed supervised
dispatch never tries another lifetime. Runtime
inspection shows the limitation; daemon-update preflight blocks limited or unknown
lifetimes while runtime-default updates leave those owners alone. Separation from
the daemon and ignoring SIGHUP do not prove logout/cgroup survival. Permanent
detached persistence is not claimed. Managerless hosts retain this labelled fallback,
and managed updates remain unsupported without a usable service manager. Native
SSH/logout/reaper acceptance remains required; a separate runtime-holding SSH
channel is an investigation, not shipped functionality or a required continuity
promise for the limited fallback. New launch records retain the kernel boot UUID
when available; detached launches require it, and an owner refuses a recorded UUID from another/unverified
boot before consuming intent. Runtime protocol compatibility covers both live IPC
and retained state, with supported majors advertised by each candidate daemon.
Host archives carry `HOST_CAPABILITIES.json`, generated through the built daemon's
passive `--host-capabilities` command. Update preflight reads bounded metadata from
the exact staged generation rather than invoking unknown candidate executables.
That metadata also records `database_schema_version`, the build's highest existing
SQLite migration number. It is application storage evidence, not another protocol
or permission to roll back. Daemon update preflight rejects missing or insufficient
candidate support, binds the observed host schema into approval, and rechecks it
after asynchronous probes. The worker checks the shutdown checkpoint's schema
again before selector changes. Runtime-default updates do not inspect daemon
storage. On startup, the daemon refuses a newer/invalid SQLite `user_version`
before changing journal mode or running application/migration writes, closing the
handle on failure. Compatible older databases still migrate forwards normally;
restoring old application data over continued runtime events is never a recovery step.
The compatibility inspector reuses the daemon's runtime bindings and authenticated
connections, checks supported majors and exact owner identity, and refuses unknown
records or an inventory changed during inspection. Runtime-only default selection
checks the current daemon's support without requiring adoption of existing owners.
This inspection does not authorise dispatch or replace impact, capacity and
quiescence checks; the coordinator composes those checks before dispatch.
The daemon also composes an interruption inventory from its existing PTY, notebook,
compilation and puddlang managers, including idle kernels and watchers. Runtime-only
default selection has no interruption impact. Controller-scoped fingerprints and
execution identities detect replacement work; they do not freeze new admissions
or authorise interruption. Final quiescence and explicit approval are separate coordinator steps.
The combined inspection uses fresh bounded storage probes and reports unsaved state,
binding its fingerprint to the exact operation/stages and runtime/impact identities.
Blocked or changing observations yield no fingerprint. Available-space measurements
remain advisory headroom, without a reservation or migration-size guarantee.
Supervision inspection corroborates the installer marker with the current daemon
PID and service identity, and includes that evidence in the fingerprint. It probes
the user manager without starting services, rejects stale/unknown supervision and
leaves manual daemons untouched during runtime-default changes.
Before read-only preflight, authorised daemon-update staging may repair a legacy
group/other-writable supervisor marker. Require an owned regular single-link file
in an owned non-shared-writable home, corroborate its kind with the exact live daemon
and service definition, then recheck the pinned inode, contents and authority before
removing only shared write bits. Failed repair leaves normal preflight blocked;
status and inspection never mutate permissions or start services. The worker
executable verifies its own PID under the recorded independent service;
systemd scopes must not contain one another. Before daemon activation, preflight
also fingerprints the existing unit and drop-ins or bounded launchd plist. The
worker rechecks configuration and outgoing service identity, issues one supervisor
stop (not a signal subject to automatic restart), then awaits its exact shutdown
checkpoint and released controller. It holds the controller claim across selector
changes, releases it before starting the unchanged service, and requires fresh
adoption proof. Daemon and combined transactions share runtime-default selection's
canonical installer. Partial changes or lost replies remain recoverable without
automatic rollback or replay. Production composition now supplies final maintenance
to private host-control daemon dispatch. Supported incomplete installations use
explicit continuation; complete installed upgrade and native failure-recovery
acceptance remain outstanding.

Application 25.11 adds explicit local/SSH completion recovery through
`puddle updates [user@host] --operation <id> --recover`. It holds the dispatch and
execution claims, fences the original worker, requires ended-worker evidence,
and uses the shared completion verifier before marking an update complete. It
rechecks the participating authority before committing. An already-complete
operation returns its recorded result. The action does not repeat installation,
stop or start commands and does not restore old application data; incomplete
selection, unavailable adoption and unknown worker lifetime leave recovery pending.
This verification-only command requires a running daemon with protocol 25.11 or newer.

Application 25.12 adds `puddle updates [user@host] --operation <id> --continue`.
With a live daemon it uses private host authority; when authority cannot connect,
the trusted OS/SSH helper invokes the verified staged daemon's pinned recovery worker.
That staged build must support 25.12. The helper passes only the exact operation
revision and returns recorded acceptance, including after a lost worker reply;
neither client path automatically resubmits an uncertain mutation. Repeating an
identical accepted helper request observes its recorded attempt. Acceptance and
worker consumption do not prove liveness or completion: inspect the operation again
to observe its verified result. Status includes bounded recovery metadata only when
requested, preserving older clients. Supporting cockpits now expose live recovery
and separate local/SSH offline continuation through the same helpers.

Read-only `puddle updates [user@host] [--operation <id>]` can inspect recorded
status when daemon authority cannot connect. The existing local/SSH bootstrap
helper reads the private bounded operation ledger with shared schema and stage
receipt validation. The CLI labels this as recorded state, without opening SQLite,
starting services, issuing a lease or repeating installation. Cancellation and fresh
adoption verification still require the live control channel. Explicit continuation
uses the separate trusted helper action described above.

The worker also writes a private bounded step journal before activation. Its exact
stop/select/start plan is bound to the operation, dispatch, worker and approval;
each step records durable intent before it may issue a component command. A lost
reply or failed completion write cannot reset that step to unattempted. Subsequent
steps remain distinguishable from attempted work, but a finished entry is not fresh
service health or runtime adoption evidence. Existing journals cannot be restarted
by ordinary execution, and missing older journals grant no replay permission.

Normal updates and internal stopped-daemon recovery share shutdown observation:
verify the original service definition, supervisor shutdown, exact drained checkpoint
and released controller, then retain the controller claim without changing its epoch.
Recovery also fences dispatch/execution, checks ended-worker evidence and recorded
shutdown intent, and validates the candidate against checkpointed database/runtime
support. Authority and lifetime are rechecked after asynchronous probes. This
hand-off issues no service command and opens no application database. Public
continuation reuses this gate before dispatching its independent recovery worker.

The host updater's internal `--dispatch-recovery <revision>` mode now dispatches a
pinned independent worker for an interrupted daemon update. It uses trusted local/SSH
OS access, requires its own immutable release
and retains a bounded private attempt ledger before supervisor dispatch. Repeating
the same requested revision returns its recorded job without another dispatch. The
worker rechecks the original operation and cumulative action journals, proves
its independent service/process group, and records one execution before component
commands. Each accepted attempt fingerprints all previous step intent; a later early
failure cannot erase previously attempted work. Missing or mismatched consumed
journals block continuation. Before daemon startup, recovery retains the original
shutdown checkpoint/controller claim. Unattempted selections use the canonical
installer; attempted selections must already verify. After an attempted daemon
start, recovery requires fresh adoption and unchanged service configuration, keeping
the replacement's controller without another stop/start. Connector startup may run
when unattempted and positively stopped. After an attempted start, a fresh explicit
recovery may accept separate restart evidence only when the unchanged service has no
process, the outgoing PID has ended and private manager inspection confirms
absence. The accepted evidence binds its approved service and selected daemon generation;
execution checks it again before mutations and immediately before startup, including
after a systemd start-limit reset. An observation-only attempt cannot gain restart
permission after dispatch. Healthy replacements are observed without another start;
lost start replies require observation or a new explicit accepted attempt. The worker
rechecks operation/current adoption before
commands and requires fresh completion verification. Maintenance and later recovery
retain exclusion while any recorded worker group may still have descendants.
After confirmed daemon loss, a fresh explicit attempt may authorise another start.
Recovery requires the service to be absent/inactive, systemd failed with no main
process, or an observed idle launchd registration, and acquires the existing controller
claim without minting an epoch. An idle registration is not shutdown proof: explicit
recovery unloads it under that claim and verifies removal before bootstrap. It
reads the current committed SQLite WAL state without migrations, checking the
worker/candidate schema ceilings, checkpointed cursors, current runtime identities
and protocols, and the installed runtime default. Its private accepted restart
evidence binds those observations and is checked again by execution and immediately
before startup. Stale controller flags alone never prove absence. Owners observed
during recovery are retained in the adoption requirements alongside the original
checkpoint; completion must prove all of them through fresh authority. No database
is restored and no selection is repeated. Packaged
crash/start-limit/connector acceptance and stopped/unmanaged
installations remain incomplete; the existing public `--recover` still verifies
completion only.

Before any activation command, the updater confirms its independent service,
requires that it leads its own process group and durably records that group against
the operation, dispatch and worker identities. Commands remain in that group.
Recovery probes the group with signal zero and accepts only confirmed absence;
permission errors and reused groups cannot prove exit. Maintenance release after
worker execution requires that evidence too, in addition to the free execution
claim. A fenced job which never claimed execution cannot run component commands.
The private lifetime record is retained with the worker, without changing any
runtime contract or adding a daemon service.

Application protocol 25.9 adds bounded read-only inspection on the connector
manager's existing exclusive private socket. Fresh nonce-correlated replies expose
only the ready process identity, release/protocols and executable paths. Preflight
corroborates the exact immutable generation and public release metadata, includes
the stable manager identity in approval and compares it again after other probes.
It rechecks runtime inventory synchronously after that final asynchronous probe.
Old managers, unavailable/malformed replies, unpinned paths and offline/ambiguous
installations cannot establish absence or approval. Runtime-default updates do not
need connector inspection. Preflight now also corroborates the live PID with the user supervisor and fingerprints
the existing connector definition through the daemon's shared replacement helpers.
The private worker job carries explicit absent/running connector evidence. Before
stopping the daemon, the worker reinspects the approved connector, stops its exact
service once and waits for service removal/inactivity, process exit and socket
absence. It starts the same definition after daemon selection/start and requires a
fresh manager identity in the selected generation before final daemon adoption
verification. Worker, daemon and connector termination scopes must be separate.
Uncertain stop/start replies retain recovery state without replay. Stopped or
unmanaged connector installations still block daemon activation. Migration-aware
recovery remains a release requirement.
No profile data, remote operation or maintenance permission is added; remote and
runtime protocols remain unchanged.

Application protocol 25.7 adds bounded, correlated maintenance requests to the
existing private host-control connection. The original begin/stage/inspect/apply/
cancel/status requests require a live host-wide local/SSH lease and never renew
authority. Separately granted remote maintenance uses the bounded application 26.0
bridge described below. The daemon coordinator serialises mutations, coalesces competing
preparations and corroborates stage receipts against host files. The winning CLI
caller stages through the existing transport and embedded installer. Runtime-default
apply repeats inspection, matches exact approval evidence and rechecks authority
before consuming dispatch. The coordinator's daemon path additionally drains an
ordered pause before reinspection and passes exact outgoing controller/service
evidence into the private worker job. Rejected attempts release the pause; accepted
or uncertain dispatch retains it until shutdown or a terminal/recovery-fenced
operation with no executing worker. The launcher pause lets admitted launches finish
before pausing discovery/reconciliation. Production uses this composition after boot
reconciliation and auto-resume finish; there is no user-selectable switch. Accepted
work survives caller loss; reconnect only observes it. Supported supervised daemon
updates can now dispatch through private host control. Runtime and ordinary daemon
install/upgrade commands consume this coordinator, sharing staging, review, exact
interruption approval and bounded observation after lost apply responses. Declining
interruption leaves the staged operation available; changed authority or impact
prevents dispatch. An unavailable modern host or failed inspection cannot fall back
to the legacy installer. First installs and legacy transitions retain the embedded
bootstrap. Launchers start the selected installed daemon service before considering
an update, and approved legacy handshake updates use the shared upgrade entry.
Cockpit routes and impact approval UI share the coordinator. `puddle updates`
inspects durable operation state and supports exact pre-dispatch cancellation.
Ordinary connector permission remains unchanged; the separately granted remote
maintenance bridge is described below.

Application 25.13 adds `GET/POST /cockpit/updates` to local, SSH and development
cockpits, using `cli/src/lib/host/updates/cockpit.ts` and the existing host update
coordinator. GET reports live availability, daemon version, supported recovery and
interruption actions and bounded operation state. POST separately prepares exact
daemon/runtime releases, inspects impact, applies matching approval, cancels or
requests supported live recovery. It accepts no host selection, paths, tarballs,
receipts or arbitrary commands; the cockpit supplies its own protocol. Preparation
uses the existing staging helper without activation. Replies omit stage receipts,
worker identities and private blocker target paths. Each mutation uses an existing
host-control client on a separate cancellable channel, tied to the original cockpit
lease and authenticated browser request. Closing/revoking either before dispatch
closes the child lease; other windows retain their connection and accepted host
operations remain durable. Reads remain available during preparation; mutations
are serialised per cockpit and coalesced by the host coordinator. Lost replies
never trigger mutation replay or offline fallback. Older compatible hosts advertise only
their supported actions. Application 25.16 adds labelled recorded status when the
daemon connection is unavailable, reusing the trusted local/SSH helper's bounded
ledger reader. The cockpit retains exact browser authority checks and discards
responses after cancellation or a connection change. Settings distinguishes the
last connected daemon version and timestamped recorded operation from current
service health or adoption proof. Live mutation capabilities remain disabled while
disconnected; explicit offline continuation is described below.

Application 25.17 adds explicit **Continue recovery on host** for a recorded,
dispatched unfinished operation with a supporting staged daemon. The cockpit sends
only its exact id/revision through the selected trusted local/SSH helper; the existing
browser authority and Origin boundary remains required. The helper uses the existing
private request/reply envelope over an open input channel, and the pinned dispatcher
checks that participation before recording recovery acceptance. Browser cancellation,
helper interruption, channel closure or cockpit reconnection revokes pending dispatch.
Accepted recovery retains its independent worker and never creates or renews a browser
lease. Lost replies cause inspection only; identical accepted requests return recorded
acceptance without another dispatch. A staged build before 25.17 cannot use this mode
and still requires explicit CLI recovery. Recorded state remains distinct from live
service health/adoption. The reconstructed v0.3.14 first-upgrade fixture now covers
declined/approved launcher consent and automatic/manual resume. Native desktop
approval and remaining packaged platform recovery acceptance are still required.
This offline path adds no remote maintenance scope; runtime protocol remains 1.0.

Application 25.14 adds optional `include_catalogue` to private update status and
an optional catalogue in cockpit status. `updates/catalogue/` reads bounded committed
runtime bindings and existing connections to group running, starting and unavailable
builds, reports the selected runtime default and running daemon version, and marks
truncated/failed inventory. It never scans native conversations, contacts every owner,
or substitutes these counts for update preflight/adoption proof. No runtime ids,
profile data, paths or process details leave this presentation boundary.

The first catalogue read starts one host-owned latest-stable release poller, using
the desktop's 30-minute cadence and a bounded shared GitHub lookup. Attempts and the
last successful result persist under `updates/release-check.json`; daemon replacement
honours the remaining cadence and network failures retain timestamped last-known
information. Persistence failures preserve in-memory discovery and do not block
connections. Shutdown aborts outstanding lookup and ignores late replies. Published
host archives embed their release repository, with a host environment override for
development; unconfigured builds perform no lookup. Only the matching host archive
plus SHA256SUMS establishes asset availability, not download/integrity completion.
Discovery never stages, changes a pin, activates or restarts anything. Cockpit
preparation obtains its repository through private host status and reuses the normal
installer; the browser cannot provide a repository or tarball. Host-wide status
subscribers receive `host-updates-changed` after discovery changes and update controls;
ordinary profile-scoped viewers receive neither the event nor private catalogue access. CLI,
desktop and host share latest-release parsing and stable version comparison.
Recorded status and explicit offline continuation are available to supporting
local/SSH cockpits; native platform and real-provider acceptance remain unfinished.
The catalogue addition did not change the remote or runtime protocols.

Settings → Host displays this inventory and release history, prepares selected components,
and separates impact review from explicit apply. Interruption approval names the affected
daemon-owned work and carries its exact fingerprint; stale operation revisions require
another review. Accepted operations remain observable after closing Settings, and supported
live verification/continuation actions are explicit. One shared query serves these controls
and shell offers. Host invalidations/reconnection refresh reads only; mutations neither
retry nor wait in an offline queue. Each window offers each host/component/release once,
retaining dismissal across React remounts and reconnects. Offers open Host settings and
never activate software. Compatible cockpit/daemon release skew remains supported.
Remote browsers require an explicit host-approved maintenance grant, separate
from pairing. Application 26.0/remote 5 carries the exact admitted Noise device,
host registration and grant identity on a manually participating private control
lease. The daemon independently checks private host state on admission and every
maintenance authority check; revocation invalidates that lease permanently.
Local/SSH Settings grants or revokes this permission. Existing paired devices
receive none, and remote administration cannot grant it to itself.

The connector's bounded `/api/host/updates` bridge uses private host control,
avoiding a request waiting on its own API admission pause. Ordinary profile HTTP
and WebSocket permissions remain unchanged, including direct HTTP denial of that
path. Host-owned preparation reuses the canonical installer and winning-caller
staging sequence; inspection, interruption approval, activation and online recovery
reuse the coordinator. Browser input contains no executable path, repository,
stage receipt or identity. Remote results remove private evidence, blocker paths,
free-form operation messages and repository configuration, retaining aggregate
component versions and interruption counts. Offline continuation remains local/SSH.
Dedicated child control channels close on cancellation, parent loss or revocation;
only explicit browser participation renews them. Accepted updates survive connection
loss and reconnect is observation-only. Remote windows poll status every 60 seconds
and on reconnect/open for release offers; local windows retain host invalidations.
Their feature gates compare the fixed introduction version separately from the
current application major, so resetting the minor in a later compatible major
does not hide existing controls. Unknown or incompatible hosts remain refused.
The session menu's Runtime inspector (25.15, local/SSH) shows its current build,
installed default and live agent/shell tabs. Restart requires explicit acknowledgement
that shell jobs and process state are lost and extra shells close. An opaque review
fingerprint binds the current runtime, placement, exact native ref, terminal generations
and selected immutable release. The existing control queue re-inspects before stop;
normal resume follows only confirmed clean exit, with authority and selection checked
again before launch intent. Unknown conversations, unavailable owners, unsaved history
or changed reviews refuse restart. Software installation never invokes this action.
Runtime inspection/restart remains local/SSH-only. Granted remote host-software
updates do not confer permission to restart an existing runtime.

Application 25.10 adds exact interruption consent to private local/SSH update
control. When other checks pass but daemon-owned work would stop, a supporting
client receives a separate interruption fingerprint with affected counts; ordinary
`can_apply` remains false. Apply must explicitly repeat that fingerprint as
interruption approval, matching the release and impact inspected again under the
maintenance hold. Missing consent retains the stage for confirmation, changed
evidence invalidates approval, and the worker persists matching consent before
dispatch. Clients below 25.10 retain the blocked response without extra fields;
new clients never send interruption approval to an older host. This adds no lease
authority or remote permission. Cockpit impact review now repeats this exact
fingerprint only after explicit interruption approval.

Local/SSH startup of an installed independent-runtime host uses the selected pinned
host updater's trusted `--start-daemon` entry, not the installer. It holds update
coordination/execution and controller claims plus the existing installer lock while
checking selected executables, the supervisor marker and unchanged service definition.
The loaded systemd command must point to the selected daemon wrapper; launchd's plist
must match its exact label and arguments. A loaded launchd job with no PID is observed
through the existing GUI-context and documented list-column checks. Explicit startup
rechecks it and the validated plist under controller/update/installer exclusion, unloads
the exact registration once and verifies its absence. It then bootstraps the validated
plist without trusting or kickstarting the previously loaded definition. A lost unload
reply or changed evidence stops the attempt; a later explicit request can inspect the
unloaded job. Shutdown verification still requires registration removal, since an idle
job can start itself. Systemd failed services require no main process. The helper releases
the controller claim immediately before one start/bootstrap, retaining update/installer exclusion;
normal daemon startup creates the new controller and adopts surviving runtimes.
The helper changes no selector, definition or controller record. Dispatched incomplete
updates require explicit recovery; undispatched preparations do not prevent startup.
Prior completed workers must have ended. SIGINT/SIGTERM/SIGHUP stop helper commands
and release claims/installer exclusion. Installer exclusion now uses the permanent
private regular file `bin/.install-lock`, shared by the shell installer and startup
helper. Its non-blocking OS file lock survives in command descendants and releases
only when all references close, including after SIGKILL; neither owner unlinks the inode.
Linux uses `flock`, and macOS uses the system Perl's `flock` on an inherited descriptor.
Installer staging work lives under `cache/install/`; long-lived nohup launches close
the installer descriptor. Older installers' directory creation refuses this file.
An existing legacy directory lock remains ambiguous and is never removed automatically;
symlinks, hardlinks, non-private files and unexpected contents also refuse acquisition.
Removal/purge must preserve this exclusion alongside runtime references; that wider
lifecycle audit and platform acceptance remain release gates.
Authenticated readiness is shared by launchers, SSH attachment and stopped-host explicit
upgrades. Lost startup replies cause observation without another start or bootstrap
fallback. Different compatible release versions remain valid. Explicit startup and
accepted replacement recovery can clear a systemd `start-limit-hit` result on the exact
stopped unit once, retaining controller exclusion through the reset. They recheck the
unchanged service definition and confirm an inactive successful result before starting;
recovery also revalidates current database/runtime evidence immediately before releasing
the controller. Lost reset replies stop the attempt without starting or retrying. Other
failed results do not trigger a reset. Packaged platform acceptance remains unfinished.
This host-only executable mode adds no REST/WS, remote or runtime protocol change.

Maintenance participants also cover queued runtime controls, asynchronous native-ref
capture/resume repair, marker-file synchronisation and compilation providers. They
reuse host admission: admitted work may finish, new commands fail without queuing,
and shutdown remains irreversible after a pause release. Native observation drainage
finishes ref capture before closing shared-store adoption, preserving work triggered
by the capture callback. A daemon-owned legacy agent cannot use this observation
pause because it lacks a retained independent identity journal. Marker watchers close
and rescan current file contents on release. Compilation retains admitted builds and
coalesces observed eager changes until release; rejected manual runs are never
replayed. Programme admission drains prompt dispatch separately from its result:
accepted independent turns continue, while later runner requests await bounded,
cancellable admission. Releasing the hold sends each waiting request once; shutdown
discards unsent requests, interrupts all runners and preserves accepted independent
turns. Programme cancellation waits for admission too. Notebook admission drains
startup through request dispatch, retaining submitted cells and idle kernel state
in the interruption inventory; new execution and kernel controls fail during the
hold. Production final inspection drains clients, upkeep and log retention first;
then programmes, compilation, catalogue and marker watchers; then launches; then
native observations, runtime controls and notebook dispatch; then notification and
service cleanup; finally discovery followed by reconciliation. Owner connections
remain open throughout. Release restores those participants in reverse order and
refreshes account observations. Log retention abandons an in-flight temporary copy
before replacing its original file, and shutdown cannot reopen retention. Long admitted
compilation or programme startup can still exceed the bounded pause deadline,
causing pre-dispatch rejection and release without cancelling that work.

Client admission is shared by HTTP and WebSocket handlers. A maintenance pause
refuses new commands while allowing existing terminal output/status delivery and
version inspection. Shutdown closes admission irreversibly, fences delayed local
PTY launches and waits for admitted handlers before closing terminal state and
SQLite. Admission drainage is distinct from the accepted update's shutdown
checkpoint, which records ownership and committed cursors before controller release.
If runtime connection drainage fails, shutdown retains SQLite and controller
ownership until process exit; a deadline does not establish that callbacks stopped.
The internal shutdown path can now accept an exact already-dispatched daemon update
reference. Signal-driven shutdown also selects that reference from an accepted
private worker record addressed to its exact PID and controller id/epoch. A later
controller cannot reuse the instruction; missing, damaged or mismatched job evidence
leaves ordinary shutdown available without an update checkpoint.
After all writers and runtime discovery drain, it flushes the SQLite WAL
and writes a private checkpoint under `updates/checkpoints/<operation>.json` before
releasing controller ownership. It records the outgoing controller, schema version,
exact runtime launch identities, pinned builds and committed event cursors, including
owners which ended during drainage. The record is bounded to 4,096 owners and 8 MiB,
contains no provider environment or credentials, and cannot overwrite an existing
checkpoint. Invalidated dispatch or failed persistence leaves shutdown incomplete
and retains the controller and database. This supplies shutdown evidence only;
replacement adoption requires separate verification. Application protocol 25.8 adds an optional
fresh nonce to exact-operation private status requests. The replacement coordinator
can publish a private adoption receipt only for an executing or recovery-required
operation with a recorded worker identity, its exact
staged generation/Node/entry point and a newer controller epoch. Every checkpointed
owner must retain its launch identity/build and committed cursor, with settled
authenticated placement binding or a confirmed final exit; interrupted or unknown
ownership cannot prove success. Failed observations do not refresh old receipts.
Publication flushes SQLite first; compatible readers ignore additive metadata
while the checkpoint digest still covers all stored fields.
The shared completion verifier under `updates/verification/` checks the exact
nonce/checkpoint/stage, live controller
and daemon port/PID records, a new private host lease and a bounded authenticated
HTTP version response. It also corroborates the replacement daemon's service and
unchanged configuration, freshly inspects the approved absent/running connector,
and rechecks selected generations, operation revision and controller after asynchronous
probes. The worker uses this same verifier after activation. Recovery-phase inspection
can produce fresh evidence without repeating installation or service mutations, but
does not itself resolve the operation or authorise another dispatch. The explicit
25.11 recovery action adds worker-lifetime exclusion and the final authorised
transition. Explicit continuation handles supported incomplete installations,
including through the trusted local/SSH helper when the daemon is stopped. Lost
replies remain observation-only. Relay maintenance uses its separate host-approved
device authority and does not expose offline continuation.

The [persistent runtimes roadmap](docs/roadmap/persistent-runtimes.md) specifies
one independent `puddler` process per live runtime and cockpit-managed host
updates. The production implementation under daemon `runtime/` provides the
independent `puddler` entry point, private bounded IPC, process-lifetime ownership
claims, controller fencing, single-use launches, terminal ownership and retained
exit records. A bounded private event journal retains terminal creation/exits
through controller outages; paginated replay and acknowledgement follow the
daemon's committed observation cursor. Asynchronous persistence retries never
block PTY drainage, and overflow reports incomplete history. Agent runtime
launches own adapter resources, a bounded nonce-only hook endpoint, native
conversation claims and exact lifecycle observations independently of controller
connections. Provider-specific flags/parsers remain in the existing adapters;
their live context requires only the account's configuration directory. Runtime
protocol 1.0 is independent of the application and remote protocols; its schemas
and versioning rules live in shared `runtime/` and `RUNTIME_PROTOCOL.md`.

Implementation lives in `packages/daemon/src/runtime/`: `index.ts` and `host.ts`
compose the owner, while `ownership/`, `transport/`, `execution/`, `state/`,
`controller/` and `lifecycle/` group their supporting responsibilities. Tests use
the corresponding groups under `test/runtime/`, with shared fixtures in
`test/helpers/`. The executable entry point stays stable and consumers import
implementation modules directly.

Host release archives now also contain `puddler`, `daemon/puddler.mjs` and plain
`RUNTIME_PROTOCOL` metadata. Both host entry points share the archive's pinned Node
and native modules, the common release `VERSION`, and one bundle configuration.
`puddler --version` reports its build and private runtime protocol without starting
an owner. Release CI verifies the packaged executable with an isolated shell and
controller replacement. The embedded bootstrap accepts an explicit daemon or runtime
component, independently selecting `bin/current` or `bin/runtime-current` through
the same immutable staging path. Both selectors can share a verified tree. Runtime
bootstrap is mandatory for a fresh daemon install or a legacy daemon-only upgrade:
when the archive includes runtime support and no runtime selector exists, the
installer validates and durably publishes its first runtime default before selecting
the daemon. Existing runtime pins remain independent, including during daemon
repair. Staging and exact activation never add an unreviewed component. An interrupted
bootstrap retains any generation already referenced by either selector.
Ordinary bootstrap also reuses the staging verifier to write a private immutable
receipt for each newly extracted generation with protocol metadata. Checksum
verification, extraction and hashing use one private snapshot of the archive.
Reused trees and their receipts remain unchanged; historical archives without
protocol metadata remain unverified, and unchecked local archives retain that
explicit status. A durable receipt survives a later publication failure for
diagnostics and reference-aware collection.
Runtime
installation validates its exact version/protocol report with bounded smoke output
and time, changes no supervisor registration and starts/restarts no service.
`puddle --version` includes the selected runtime build and its private protocol.
The same bootstrap supports `--stage-only` and exact `--activate-generation` with
an expected receipt digest. Staging copies its input before checksum verification,
checks exact version/protocol output, fingerprints the tree under fixed time/byte/file
limits and fsyncs a private receipt. It changes no selectors, wrappers or services.
Activation rechecks receipt identity, tree contents and smoke output, then selects
that generation without another release lookup or download. Failed activation keeps
the diagnostic stage and previous selection. This private local record is neither
an update approval nor another connection protocol. Runtime install/upgrade now uses
the durable coordinator and surviving updater. Daemon and combined updates share
transactional recovery. Runtime removal uses coordinated daemon removal with
reviewed retention/stop choices; reference-aware maintenance keeps live builds
pinned and collects only eligible unreferenced generations. There is no standalone
runtime-uninstall command or selectable backend to disable.

The update coordinator's private operation store lives under `updates/operations/`,
with a bounded `updates/operations.json` ledger in the host home. A current operation
and 32 historical terminal operations retain exact stage receipts and separate
preflight, approval, dispatch and verification identities. Revisions fence stale
writers; matching in-progress requests observe the same operation. A single-use
dispatch and OS-held worker claim prevent concurrent execution or replay after a
crash. Uncertain application/verification keeps the operation nonterminal until
explicit verified recovery, fencing delayed starts. The record is file-and-directory
synced through the existing private JSON writer; bounded reads fail closed. Runtime
and update claims share `security/claims.ts`, preserving the existing `runtime-claims`
inodes for owners launched by older builds. The host updater
connects that store to an independent one-shot systemd/launchd job. Its immutable
release supplies the exact Node binary, worker bundle and canonical `install.sh`;
the private job record is synced before supervisor dispatch and retained after an
uncertain reply. Workers claim the accepted dispatch once, activate its exact stage,
and verify the actual selected generation and executable metadata before completion.
Installer `--select-only` requires exact activation and preserves the recorded
supervisor, unit/plist files and running services. Selector publication is directory
synced. Worker children remain in the service process group, and worker lifetime is
bounded to three minutes. Runtime owners and workers share `host/services.ts` for
literal supervisor definitions and bounded dispatch commands. Systemd working
directories use literal, specifier-escaped paths rather than command-argument
quoting; native unit-parser checks cover runtime and updater definitions.

The private host-control dispatcher composes daemon and combined updates with
final quiescence and exact compatibility/impact approval. Unverified supervision or
compatibility remains blocked. Runtime and ordinary daemon CLI updates, launcher
handshake upgrades and cockpit controls share the coordinator. Explicit recovery
uses retained execution evidence without replaying uncertain actions. Mandatory
bounded maintenance retires eligible completed jobs and collects only generations
proved unused; ambiguous references and rollback pins remain retained. Native
service-retirement, reboot and remaining recovery acceptance are still required.

The runtime agent state reports sidecar roots and hidden ports, and retains
interactive fallback when installed-version checks fail. Provider version probes and
Codex sidecars use the launch environment, including its executable search path,
rather than relying on the service manager environment. Codex lifecycle cleanup
waits for app-server exit and escalates to SIGKILL after 1.5 seconds if needed.
If its bridge cannot start, Codex 0.164+ interactive fallback uses `--no-daemon`
and remains marked as degraded synchronisation. It must not attach to the shared
Codex daemon, whose idle conversation retention can outlive the PTY and block an
immediate restart. Existing shared-daemon conversations may still need their
native inactivity grace period before a replacement can acquire them. New owned bridges on Codex 0.166+ use zero idle thread-unload delay in both TUI and app-server configuration; busy native work is never forcibly unloaded.
OpenCode 2 interactive and headless launches similarly use `--standalone` to
keep their server inside the runtime lifetime, including degraded interactive
launches. OpenCode 2.2.5+ within major 2 uses a separate managed TUI plugin: the selected router state binds native identity, while durable inbox delivery, assistant-step and execution events correlate exact replies. Read watermarks and unrelated server activity never select a conversation. A managed blank/home route creates one native session before the first prompt, with navigation and cleanup fenced against late replies. The stable loader selects each owner's pinned helpers; older owners without V2 assets remain inert. Earlier V2 and unverified future majors retain fallback synchronisation. OpenCode 1 retains its existing private-server startup arguments;
Claude Code and Gemini use their foreground CLI and hook-based integrations. Claude's native background copies carry `CLAUDE_JOB_DIR` and inherit the foreground hook nonce. Unattached copies' hooks remain inert. For the verified Claude 2.1.318 supervisor protocol, a newly discovered background fork of a managed live source attaches in a separate Puddle terminal; the original remains active. Catalogue metadata only proposes attachment: the normal admitted launcher verifies the account, exact job, native conversation, working directory and worker processes. Persist one attachment intent and never retry an uncertain launch automatically. Archived, historical, foreign-account and unrelated copies are not auto-attached.

The Claude viewer binds one native job through a private bounded terminal bridge; leaving that view cannot open Claude's agent picker and silently select another job. Detachment and owner recovery preserve the worker, while explicit session stop issues one verified native stop and checks worker exit. An unavailable or unsupported supervisor never permits duplicate foreground/headless execution. The supervisor's launch conversation ID remains distinct from the current conversation after `/clear`; native hook routing and fresh CLI observations resolve the latter. Per-job private routes select each owner's pinned helpers and nonce, preserving foreground V1 dispatch compatibility. Reattachment does not submit an interruption prompt or replay input. Because a native composer may retain a draft, automated input remains unavailable until a native turn establishes a clean boundary. Runtime 1.1 advertises this launch capability; the daemon checks the exact pinned runtime before dispatching a live-job resume. Major-1 adoption and existing IPC/retained-state shapes remain compatible, and ordinary launches do not require the feature. This integration does not imply installed-profile, paid-provider or cross-version acceptance.
If a foreground-mode version probe is inconclusive, the adapter refuses launch;
both runtime and legacy composition preserve that refusal instead of invoking
an unqualified CLI fallback. Ordinary unsupported hook integrations may still
degrade without changing process ownership.
Optional Claude and Gemini capability probes may reuse one private account-local version
observation for at most 30 seconds, keyed by executable identity, arguments and
launch environment. Replacing the executable or changing the environment invalidates
it; runtime hook paths/nonces are excluded from the probe. Mandatory foreground
ownership checks never use a persisted observation. Cache failures fall back to
the bounded native version command.
Runtime IPC admits one provider turn at a time using a monotonic runtime-local
identity and exact native-ref check. It reserves bounded journal space before
dispatch, retains results across controller replacement, and records cancellation,
human takeover or runtime-exit interruption without replaying input. Runtime-owned
helper copies, stable account dispatch and separate mutable turn records preserve
managed hook/plugin code across account updates. Launches pin immutable executable,
native dependency and helper trees. Production session and programme controls use
these owners; reconciliation retains accepted results across controller replacement
without restarting programmes or replaying prompts.

Runtime owners also retain private captured-environment and shell-directory
reports through controller outages, with the existing capture gate/denylist and
bounded values/counts. Observation coalescing preserves native lifecycle and
control boundaries. Current captured values seed new PTYs; values stay out of
ordinary runtime inspection and terminal logs/screens. These records and explicit
capture/purge controls are routed for adopted owners. Reconciliation commits
observations to the application database and converges the profile capture policy.

Cockpit terminal fits send no resize before attachment; pending geometry is
coalesced until the replay arrives, including after reconnect. Resizing ended or
historical views changes only the browser grid, with no live runtime mutation.
Restored focus and mouse modes can emit reports when browsing these transcripts;
exact focus, click, drag and wheel reports are ignored after confirmed exit or
on historical views. Live reports still reach the application. Typed input,
reports mixed with input and uncertain delivery remain errors.

The runtime owner tags output/snapshots with a native-lifecycle segment id,
writes separate raw logs per segment and terminal generation, and saves immutable
boundary/exit checkpoints while keeping live emulators intact. Bounded asynchronous
checkpoint writes report a history gap on failure; historical reads validate their
identity and never substitute a different segment. Native switches clear the
owner's acknowledged placement; mutations require an explicit segment/placement
address and remain fenced until the daemon commits and binds the new placement.
Snapshot reads preserve the owner's grid rather than resizing it. Bounded raw-log
compaction requires exact retired-writer evidence and preserves replay tails;
unread or unresolved programme results remain protected by retained-result
accounting. Owner-local buffer limits share the sealed host memory allowance,
including persistence scratch/work capacity. These bounds do not claim a physical
filesystem quota or a limit on arbitrary native-provider memory.

Migration 029 adds `runtime_bindings` for immutable launch identity, active
placement/conversation, build metadata and transactional observation cursors.
Migration 030 adds immutable segment-to-placement history and the active segment
pointer. Launch intent includes the initial segment; each switch commits its
boundary, placement, cursor and application effects together. Older experimental
rows without segment evidence cannot acquire an invented binding. Runtime owners
never open this database; their binding acknowledgement follows its commit.
The daemon now acquires the runtime controller claim and inspects known external
owners with bounded concurrency before its legacy boot-reconciliation pass.
Prepared/running runtime bindings protect their active placements from blanket
interruption and auto-resume, including when owner authentication or connection
fails. Shutdown closes these control streams without stopping their owners and
releases the controller only after application writers and servers stop.
Migration 031 stores private terminal/capture observations and bounded turn
results. Boot and live journal reconciliation commit native switches, immutable
segment mappings, environment changes, terminal inventory, results and the event
cursor in one transaction per page. The daemon then binds the committed placement
and acknowledges retained events. Results never enter public audit events; full
private retention or an incomplete journal leaves reconciliation pending without
replaying execution. Owner state is checked against committed observations before
binding. Disconnected owners reconnect with bounded backoff; no uncertain
command is retried. After acquiring the exclusive owner claim, the daemon fences
any delayed start, imports all final journal pages and commits the ended binding
atomically. Complete final exit records remain exited/failed; confirmed owner loss
becomes interrupted and unresolved accepted turns retain an interrupted outcome.
A journal gap or failed database commit preserves unresolved ownership. Confirmed terminal boot losses follow the
configured auto-resume policy; natural
exits do not resume. Agent owner loss remains explicitly resumable until supervisor
cleanup can prove provider sidecars and descendants have ended.
Migration 040 records explicit read/discard dispositions for retained terminal
programme outcomes. Application 26.1 exposes bounded metadata inspection and
exact fingerprint-bound actions to local/SSH users and their CLI/MCP clients.
The run must have finished; profile, operation, runtime and turn ownership remain
checked. Audit and consumption commit atomically without replaying execution.
Only explicit reads return retained reply text. Both choices allow ordinary
capacity reclamation, even if a read response is lost; repeated requests observe
the same disposition and return text only while retained. No audit asserts
delivery, and running/unknown outcomes never expire automatically.
Migration 039 queues ended runtime registrations atomically with their final
binding state and seeds previously ended owners. An indexed pending queue supplies
at most 32 owners per pass, with four removals in flight; unavailable owners cannot
starve later pages. Cleanup acquires launch, dispatch and owner claims, verifies
the exact host/runtime service target and fences delayed starts before removal.
Both already-absent registrations and successful unregister commands require bounded,
positive absence inspection through a reachable manager. Systemd must report the exact
unit missing, inactive and dead with no main PID or pending reload; launchd must report
the exact job absent in an available domain. Historical `removed` records are reinspected
when cleanup is invoked again, and a reappeared registration is removed under the same
claims. Other failures remain pending. A completed database receipt prevents repeated
background collection after daemon replacement; it is not current service or release
collection evidence. Shutdown drains pending
commands before closing the database and releasing controller authority.
Registration cleanup preserves journals, checkpoints, results and pinned assets;
it is not proof that unmanaged provider descendants have ended. Reference-aware
collection requires separate retirement evidence, including the verified reboot
barrier for unresolved descendants. Actual provider-descendant and reboot
acceptance remains open.

The internal host removal runtime phase now lives in `host/removal/`. Its offline
controller acquires update, controller and installation exclusion before opening the
existing application database, requires the current schema without migration, and
reuses runtime discovery, reconciliation and serial controls. Unknown on-disk owners
and unfinished updates prevent a complete review. The bounded review lists exact
runtime/placement identities, live terminals and pinned releases. Explicit retention
leaves processes and files intact; explicit stop rechecks impact inside each control
queue and uses durable stop intent. A recorded uncertain stop is never resent by this
path. Changed native refs, terminal generations, owners or releases require fresh
review; output acknowledgements and resize do not. All admitted inspection/control
work drains before releasing ownership. An outer removal guard can retain update and
installation exclusion across service shutdown, the offline runtime phase and final
file handling. Child commands inherit the installation descriptor; releasing the guard
while it still owns the controller is refused. The configured home spelling is preserved
for installed executable arguments, with canonical location checks for guard reuse.
Internal service teardown reviews owned bounded definitions and exact supervisor/process
identity, reuses the update shutdown checks, and observes a lost stop reply without
repeating it. Definitions remain available until shutdown is confirmed. Unregistration
requires controller ownership, unchanged definitions and stopped-process evidence;
systemd disable/reset/reload and final manager-backed absence must be confirmed.
The internal service phase now records a bounded private journal under
`installation/removal/services.json`, pinning the selected release, reviewed services
and original definition bytes. It shares the updater's durable serial action writer:
intent is persisted before dispatch, completion after observation, and a started action
cannot be dispatched again by reopening the journal. Explicit observation can complete
a consumed stop or unregistration only from fresh service/process/definition evidence.
New plans record systemd disablement, failed-state reset, definition deletion and
manager reload independently; launchd deletion follows its recorded unload. Explicit
continuation verifies consumed steps and dispatches only still-planned steps. Deletion
checks the bounded original bytes, ownership and inode immediately before unlinking
and syncs the service directory. After deletion, systemd may need a reload while the
unit is still known but inactive; this is admitted only at that boundary, and final
completion still requires fresh manager-backed absence. Older coarse plans remain
readable and observation-only after their unregistration intent has been consumed.
Missing or malformed journals are never recreated by continuation. Original definitions
may contain environment values and remain private host data. These records support
future removal/reinstallation orchestration; they do not themselves disable remote
registrations, decide runtime disposition or restore an installation.
An active removal record fences direct daemon startup before authority/database access,
selected-service startup, update ledger mutations and the embedded installer. Passive
update inspection remains available. Missing selectors cannot turn a removal-only host
into a legacy bootstrap candidate. Malformed or linked active records remain blocking;
unavailable inspection is never permission to start or overwrite the installation.
An unattempted service plan can be cancelled under removal exclusion: every action must
still be planned, then a same-directory rename retains one private cancelled review and
clears the active fence. Old operation objects cannot cancel a later plan. Once any
intent has been recorded, explicit recovery is required; complete service unregistration
also retains the fence until explicit configuration restoration completes. This does not terminate
the already-running daemon or independently hosted runtimes during review/cancellation.
The internal restoration phase under `host/removal/restoration/` requires completed
service removal, the same selected release and retained controller/update/installer
exclusion. It publishes the original definition bytes into their exact user service
paths without overwriting an existing file or link. Publication and subsequent recovery
observation sync both file and directory. Systemd reload and enable steps share the durable
action writer; consumed commands are observed, never replayed. Explicit continuation
requires the existing exact restoration journal, never a newly created substitute after
missing evidence. Enabling omits `--now`; the service stays stopped. Changed definitions,
unknown shutdown, revoked authority or
unconfirmed enablement keep the removal fence. After fresh configuration/stopped-service
checks, a same-directory hand-off retains the completed removal record and clears that
fence for ordinary selected startup. Restoration history is bounded to the current and
previous action records plus the latest restored review. This phase never starts a
runtime, changes a selector, restores application data or re-enables remote registrations.
`puddle install daemon` now checks passive selected-release capabilities before its
already-installed shortcut. Supporting application 25.18 helpers expose only bounded
recorded state and an exact removal id over trusted OS/SSH execution. An incomplete
removal refuses installation; completed removal can restore its saved configuration,
and an existing restoration journal requires explicit continuation. The helper pins its
own Node/entry/selected release and retains update/controller/installer exclusion.
After an uncertain reply the CLI observes the exact hand-off without repeating dispatch,
then reuses authenticated readiness or ordinary selected-service startup. Repeated install
does not restart an already-connected daemon. A different explicitly requested release
follows the existing update coordinator after restoration. No private definitions leave
the host, no remote grants are added and no runtime restart is dispatched by restoration.
End-to-end retained-runtime adoption and actual Linux restoration acceptance remain
required before this is a complete reinstallation flow.
Application 25.19 wires `puddle remove daemon` to this coordinator for local and SSH
targets. It asks before disabling remote access and stopping daemon-owned work, then
reviews independent runtimes under exclusive offline ownership. The default retains
runtimes; an interactive choice or `--stop-runtimes` explicitly stops the exact reviewed
owners and shell generations. `--yes` alone retains them. Finish rechecks the review,
uses existing durable runtime stop intent, verifies unregistration and drains the
controller before recording an exact attempt receipt. A lost reply is inspected,
never resent; a later explicit removal continues the recorded service id. Changed or
unavailable evidence remains unresolved. Remote disablement precedes either service
stop and is verified again before completion; profile enablement and new connector
startup are fenced meanwhile. Registration credentials and grants are retained but
disabled, including after deliberate reinstallation.
If disablement stops partway through the profiles, a later explicit removal continues
through the selected connector helper with the exact removal id. It requires the same
selected release and started disable action, and rechecks that record across async
boundaries. Existing profile writer locks serialise inspection and disablement. Already
disabled registrations are observed and synced without rewriting or sending another
request; still-enabled registrations follow ordinary disablement. A lost live reply
also observes an already-persisted disabled result. This is reconciliation of a durable
disabled state while re-enablement is fenced, not replay of a session command. Finished
disable steps remain observation-only; renewed enablement then blocks removal.
The CLI preserves data and selected/pinned release files and directs users to
`puddle install daemon` for restoration. Persistent installations cannot reach the
legacy recursive deletion script. Application 25.20 enables coordinated `--purge`
with separate runtime stop consent (`--yes` also requires `--stop-runtimes`). It
retires every retained runtime under its launch/dispatch/owner claims and records
the kernel boot UUID after verified service removal. Because service absence and
exited rows do not prove escaped provider descendants ended, data deletion requires
a different kernel boot and explicit fresh dirty/unpushed worktree review. Exact
reviewed roots are quarantined and deleted without following links, at most 512
objects per helper call. The CLI continues only positively acknowledged batches,
bounded by 64 calls and 60 seconds; unknown/nonzero replies stop continuation.
The permanent installation/claim namespace, `bin` generations, controller record and
installation/update recovery records (including saved service definitions) remain.
Active `purge.json` fences startup,
installation and restoration after data detachment; final archival as `purged.json`
permits fresh installation. Unknown ownership, runtime records, Git state or kernel
boot evidence keep deletion blocked. Ordinary removal and updates need no reboot.
After completed purge, passive removal inspection identifies the retained service
installation as removed until explicit restoration. `puddle install daemon` reuses
the existing restoration journal and startup readiness path: prior-boot purge proof
permits ignoring obsolete process observations, the original service journal stays
unchanged, and a durable action recreates the supervisor marker. Configuration
restoration never restores deleted user data. Repeated install observes an existing
hand-off/readiness without starting the daemon again; historical purge evidence does
not override a later removal or completed restoration.
Complete platform/provider/reboot acceptance remains required. Successful runtime disposition or service unregistration
alone never authorises deleting a release, runtime record or home.
The internal collection review under `host/installation/collection/` reads bounded
release/reference inventories while retaining installer/update/controller exclusion
and the update-writer claim. It pins selectors, retained runtime bindings and helper/
supervisor executables, update receipts/checkpoints and worker/recovery jobs even
outside bounded operation history, plus retained removal records. Ended bindings
still pin their build until descendant/asset retirement is proven. Unknown or unsafe
evidence prevents a review. Verified unreferenced generations become candidates after
seven days; the fingerprint binds their receipt, inode, reference list and candidate
set. The separate executor accepts at most 32 generations into a private serial
journal, rechecks references under the same exclusion, atomically quarantines each
exact inode and deletes at most 512 filesystem objects per invocation without
following links. Lost intent/rename/completion writes reconcile source/quarantine
evidence; unknown or replaced trees remain untouched. The collecting helper pins its
own build. Only the current and previous completed collection journals are retained.
Tests include killing the helper after quarantine and continuing under fresh process
claims. Mandatory daemon maintenance now invokes this executor outside the upkeep
it pauses, borrowing the current controller and retaining update/installer exclusion.
It starts after 30 seconds, coalesces terminal-update observations with a five-minute
minimum between attempts and runs every 30 minutes when idle. Each pass has a
five-second deadline and an aggregate reference-inventory budget of 16 MiB,
16,384 entries and 8,192 references; separate control/journal/proof reads retain
their existing per-record/action limits. Shutdown fences scheduling and drains the
pass before releasing runtime control or SQLite.

Reference retirement remains separate from deletion. A runtime's unchanged durable
launch fence must span different verified kernel boots before its executable
references retire; bindings, native conversations and replay history stay intact.
Completed updater/recovery jobs require ended-group and exact service-removal proof.
Terminal operation evidence is retained before bounded ledger eviction. Rollback
pins protect at least two successful operations per component; ambiguous archived
ordering retains all unretired candidates, rather than guessing from wall-clock
timestamps. Unknown evidence stays pinned. Isolated tests verify these paths and
live runtime/shell continuity; native service/reboot/provider acceptance remains
outstanding. Coordinated purge shares the bounded no-follow tree deletion helper.

Migration 032 records terminal generations per segment and explicitly selects each
placement's terminal owner. Runtime launches/switches update that selection in the
same transaction; a later legacy spawn records its own ownership instead of
mistaking old external history for its current screen. Existing application
WebSockets now attach to adopted owners for snapshots, input and resize. Each
viewer retains its exact placement, segment and generation. Snapshot cursors
exclude already-rendered output; bounded queues, disconnects and native switches
require fresh attachments. Input is ordered, bounded and split at UTF-8 boundaries;
an uncertain chunk abandons remaining queued input without replay. Authority is
rechecked after snapshot work and before each mutation. Historical placements
read their validated immutable checkpoints and reject input/resize.
Adopted owners now handle extra-shell creation/termination, captured-environment
purge and explicit session/project stop/archive. Per-runtime control queues retain
the caller's original placement and recheck its request lease before dispatch.
Shell creation inspects owner inventory and capture policy; captured values come
from the owner. Purge returns the exact owner count and waits for the retained
clear observation to commit. Migration 033 records stop intent before dispatch;
a lost acknowledgement is observed without retransmission, and explicit stops
suppress automatic recovery. Archive requires a complete clean owner exit,
including shells remaining after the main PTY exits. Worktree removal refuses
external bindings without confirmed clean exit/descendant cleanup, even with force.
Resume and migration still reject live external ownership with
`runtime_reconciliation_required`. Inspection alone never acknowledges events or
treats a connection failure as permission to retire an owner.
Port discovery now inspects authenticated owners for main/shell and provider-sidecar
roots, excluding their advertised internal ports. The existing local/SSH proxy
uses those results. Cached scans expire immediately on owner disconnect, terminal
or provider-state changes and native switches; scans also recheck the committed
placement after asynchronous process inspection. Historical, unbound or unreachable
owners never fall through to stale recorded PIDs or legacy PTYs. Cached owner
references are bounded across old placements. No new application/remote shape is
needed for this integration.
Independent owners also answer OSC 10/11 colour queries directly through their
PTY manager. Launch context seeds the last cockpit-reported foreground/background
before spawning; adopted owners converge newer reports through private,
placement-fenced theme changes. Owners keep their colours through controller loss,
and a daemon with no new report does not clear them. Extra shells share the same
owner colours. Reconciliation inspects after a lost acknowledgement and skips
older owners whose state omits theme support. The existing application WebSocket
theme message and its last-report-wins policy are unchanged.
Provider owners retain one current attention condition with a stable UUID, native
segment and timestamp. Working again, a native switch or deliberate stop clears
it; unexpected main-agent exit replaces it with an exit condition. This is
replaceable owner state, not a historical notification journal. Migration 038
commits the inspected condition and a durable delivery claim per runtime, with
monotonic observation cursors. After reconciliation settles, the daemon delivers
only a current condition at most five minutes old through the existing
profile-filtered notification and connector paths. It rechecks placement, stop
intent and status after bounded preview work; claims precede emission, so restart
does not duplicate alerts. A crash after the claim can lose a notification; no
delivery acknowledgement or automatic resend is implied. Native previews remain
adapter-owned, with an exact-condition private terminal preview as fallback.
No preview body enters runtime metadata or public audit events. Terminal owners
reuse the foreground-agent monitor with process inspection restricted to their
main PTY. The optional private `terminal_agent` hint is transient; the daemon
exposes it only from the selected, connected owner. Explicit busy evidence arms
one idle alert, while a successful process scan can prove child exit even when
the shell remains running. Suspension, backgrounding and failed inspection clear
the hint without claiming exit. Extra shells cannot own the hint, and monitoring
never changes placement kind/status or adopts a native conversation. Foreground
agent exit conditions use the same retained attention and fenced delivery path;
deliberate stops remain silent.
Main-terminal OSC 0/1/2 titles now enter the owner's retained observation journal
with exact segment and terminal generation. The parser retains at most 4 KiB of
an unfinished sequence and resets at native switches; existing de-animation and
80-character display normalisation apply. Repeated titles coalesce only within
observation runs, never across lifecycle/control boundaries. Reconciliation
commits each title to its own placement with the observation cursor, preserving
user overrides and native conversation titles. Extra shells cannot rename the
placement. Existing session invalidation updates connected cockpits.
Default daemon composition routes terminal and interactive/headless agent
creation/resume through `RuntimeLauncher`, using `installed: true` to resolve
`runtime-current` anew on each launch. Explicit dependency overrides support
isolated tests; `runtime: false` is reserved for legacy migration fixtures. Resolve the release directory once,
read bounded version/protocol metadata and pin Node plus the entry point inside that
same tree. Incompatible majors and incomplete selections fail before intent or
command construction. Persist the selected build's actual protocol, including a
compatible newer minor, for exact adoption checks. The launcher writes a private validated
launch context and SQLite intent before one supervisor dispatch, holds a launch
claim through adoption, and waits for authenticated, reconciled readiness. Recovery
and service removal cannot retire a launch while that claim is held. A lost dispatch
reply is inspected without replay or fallback spawning; shutdown drains launches
before closing application writers. New owners retain the daemon environment below
captured values and command overrides, plus private shell-hook copies reused by
later shells. Missing pinned copies never fall back to mutable daemon hooks.
Interactive launches retain adapter-declared preset conversation ids separately
from resume refs. Providers that mint ids retain a bounded pre-launch snapshot in
private context; explicit recovery excludes those ids and refuses ambiguous new
candidates. Live rebinding uses only the owner's exact lifecycle journal. Installed
version checks determine `native_sync`, including after offline switches; lifecycle
events alone never promote a fallback owner. Confirmed failed launches reconcile
their final records without another dispatch. Headless launches leave new native
identity unset until the first structured provider turn binds it.
Migration 035 stores private `puddlang_runtime_turns` mappings from run/operation
to exact runtime, turn, placement, segment and expected native ref before dispatch.
Profile and active-run checks precede dispatch and outcome consumption. Turn ids
increase across both owner observations and reserved operations; duplicate runner
operations are rejected. Lost admission replies trigger observation without prompt
replay. Callers consume committed private results. Daemon shutdown interrupts the
programme while preserving accepted owner turns; explicit cancellation targets only
the original turn/placement. Restart recovers the outcome without resuming the
programme. Migration 036 records `puddlang_runtime_spawns` in the same transaction
as its placement, then binds the exact runtime alongside launch intent. Durable
`puddlang_stop_requests` fence future spawns even if cancellation arrives before
placement creation. Undispatched programme placements become interrupted on boot
without automatic resume. Explicit manual resume remains available and does not
transfer programme ownership to the replacement. Cancellation and failed-spawn
cleanup target the recorded owner, including after a lost launch response;
`runtime_cleanup` programme events list unconfirmed runtime ids. Explicit repeated
cancellation retries those recorded stops; boot never replays uncertain stops.
Migration 037 marks private outcomes consumed only when their exact authorised
programme caller reads them, retaining recent results until capacity is needed.
Admission and reconciliation reclaim the oldest consumed terminal outcomes within
128 records/16 MiB per owner; running and unread outcomes remain protected.
Admission reserves worst-case encoded reply space before provider dispatch. Failed
intent or observation commits roll back reclamation. A separate durable turn
watermark prevents reuse after result or programme-history removal. Consumption
does not assert delivery to the runner, resume a programme or expose its reply in
public events. Full unread retention refuses new asks before dispatch. Migration
040 adds explicit, fingerprint-bound read/discard dispositions for finished runs.
Migration 041 adds host-wide accounting for 8,192 retained/reserved outcomes and
256 MiB of charged result JSON/reservations, alongside the per-owner limits.
Only confirmed unused reservations or outcomes proved absent by complete fenced
retirement evidence can release unused charges; uncertain work stays protected.
Bounded maintenance reclaims consumed outcomes without deleting their mappings,
watermarks or disposition audit. These are managed result capacities, not a bound
on physical SQLite storage.
Code-execution terminals use that same independent owner path, including their one-shot
command followed by an interactive shell. Migration 034 stores each canonical
managed run directory in `runtime_code_runs`, keyed by runtime id, atomically with
launch intent. Cleanup consults these references after daemon replacement and
retains files until that exact owner exits cleanly; failed/interrupted/unavailable
owners remain protected. External exit observation replaces legacy PTY callbacks
for those runs. Explicit terminal resume creates a shell and never repeats the
programme. The usual five completed-run retention limit excludes protected runs.
The transactional daemon updater preserves independent owners on supported
supervised hosts. Host-session fallback retains its explicit lifetime limitation;
native supervisor/provider and SSH/logout/reaper acceptance still govern the
continuity claims for those environments.

## 3. Data model (SQLite)

```sql
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,                  -- 10 hex chars, like projects; opaque handle
  name TEXT NOT NULL UNIQUE,            -- display label only (e.g. "alice") — never keys files or URLs
  branch_prefix TEXT NOT NULL DEFAULT '',  -- app default "puddle/" (migration 008 + create); editable per profile, may be cleared to ""
  icon TEXT,                            -- optional lucide icon name (kebab-case); null → default person glyph (§11)
  icon_colour TEXT,                     -- optional theme-colour key the web maps to a text-* token; null → heading colour
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
  default_base_branch TEXT NOT NULL DEFAULT '',  -- follows the clone's current branch unless pinned
  onboarding_notes TEXT,                -- user-authored standing setup rules, injected into every worktree onboarding (§4)
  fetch_enabled INTEGER NOT NULL DEFAULT 1,    -- master switch for all fetching on this repo (create-time and periodic)
  last_fetched_at TEXT
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,                  -- 10 hex chars: short, stable URL handle (/project/:id)
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  name TEXT NOT NULL,                   -- e.g. "teleop-latency"
  abbrev TEXT,                          -- ≤5-char uppercase rail label (12.1); NULL derives from name
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(profile_id, name)
);

CREATE TABLE profile_states (            -- per-profile persisted workspace layout (see §11)
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id),   -- layout follows identity, not browser or project
  ui_state TEXT NOT NULL,                -- JSON: layout tree, editor tabs, explorer pin, sidebar mode
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_conversations (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  agent_type TEXT NOT NULL,
  agent_session_ref TEXT NOT NULL,       -- immutable native conversation id
  native_cwd TEXT NOT NULL,              -- native store truth, not placement
  native_title TEXT,                     -- native name; puddle title stays on sessions
  parent_conversation_id INTEGER REFERENCES agent_conversations(id),
  preferred_account_id INTEGER REFERENCES accounts(id),
  native_created_at TEXT,
  native_updated_at TEXT,
  last_seen_at TEXT NOT NULL,
  missing_scan_count INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0,
  UNIQUE(profile_id, agent_type, agent_session_ref)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                  -- immutable puddle placement uuid
  project_id TEXT NOT NULL REFERENCES projects(id),
  account_id INTEGER REFERENCES accounts(id),  -- current/preferred launch account; NULL for terminals
  conversation_id INTEGER REFERENCES agent_conversations(id), -- NULL for terminals and retained migration aliases
  placement_alias_of TEXT REFERENCES sessions(id), -- preserves a legacy duplicate's UUID/logs/layout refs
  worktree_path TEXT NOT NULL,
  canonical_worktree_path TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  branch TEXT NOT NULL,
  separate_branch INTEGER NOT NULL DEFAULT 1,
  branch_owned INTEGER NOT NULL DEFAULT 0, -- one placement owns worktree/branch-dependent actions
  kind TEXT NOT NULL DEFAULT 'agent',
  agent_type TEXT,                      -- NULL for terminal sessions
  title TEXT,                           -- puddle user override; native title lives above
  status TEXT NOT NULL,
  native_sync TEXT,                     -- pending | full | fallback; NULL for terminals
  skip_permissions INTEGER NOT NULL DEFAULT 0,
  session_env TEXT NOT NULL DEFAULT '{}',
  cwd TEXT,                             -- terminal-only, worktree-relative last prompt dir
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT
);

CREATE UNIQUE INDEX idx_sessions_conversation_placement
ON sessions(conversation_id, project_id, canonical_worktree_path)
WHERE conversation_id IS NOT NULL;

CREATE UNIQUE INDEX idx_sessions_branch_owner
ON sessions(canonical_worktree_path)
WHERE branch_owned = 1;

CREATE TABLE scratchpad (                -- per-profile Scratchpad: prompts + notes (see §11)
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  scope TEXT NOT NULL DEFAULT 'project', -- 'project' | 'profile' — a hard filter, not a hint
  project_id TEXT REFERENCES projects(id),      -- set iff scope='project' (store-enforced)
  title TEXT,                            -- optional short label; body's first line shown if absent
  body TEXT NOT NULL,                    -- plaintext, inserted verbatim
  tags TEXT NOT NULL DEFAULT '[]',       -- JSON array of free-form strings (filter chips)
  agent_type TEXT,                       -- optional agent association (filter)
  position REAL NOT NULL,                -- manual drag order; smaller = higher (top)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE layouts (                   -- saved layouts: named tiling-tree snapshots (see §11)
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  scope TEXT NOT NULL DEFAULT 'profile', -- 'project' | 'profile' — the layout mode at save time
  project_id TEXT REFERENCES projects(id),      -- set iff scope='project' (store-enforced)
  name TEXT NOT NULL,
  layout_tree TEXT,                      -- JSON LayoutNode (validated on read); NULL = empty workspace
  active_session TEXT,                   -- the URL-bound session at capture time
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE events (                    -- lifecycle audit trail
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  type TEXT NOT NULL,                    -- created|session_ref_captured|resumed|interrupted|exited|archived|...
  payload TEXT,                          -- JSON
  created_at TEXT NOT NULL
);
```

SQLite is the source of truth; a live PTY is an ephemeral attachment to an internal stable runtime, and a session row is an immutable Puddle placement. Native identity, parentage, cwd, title, timestamps, and existence come from `agent_conversations`; the public `Session.agent_session_ref`, `agent_title`, parent id, and missing flag are produced by joining its placement to that row. The same conversation may have placements in several projects, but only once per project and canonical worktree. Catalogue-created duplicates never acquire branch ownership; an exact live switch transfers it. Migration 021 deduplicates native refs within the owning profile while preserving every Puddle UUID, placement title/status/environment, log/event reference, and saved-layout reference; exact legacy placement duplicates remain aliases of the canonical row.

All timestamps are ISO 8601 UTC. Git operations against a given repository (worktree add/remove, fetch, branch creation, source-control mutations) are **serialised through a mutex keyed by its canonical Git common directory** in the daemon — linked worktrees share the same ref/index lock domain, and concurrent Git writes otherwise race on Git's own lock files and fail spuriously.

## 4. Session state machine

### Puddlang runs

Script execution is separate from placements, native conversations and runtimes.
Migration 024 adds `puddlang_runs` (profile, captured submission/hash, state,
result/error, timestamps) and ordered `puddlang_events`. Profile deletion
cascades these records once runs finish. Runs transition from running to
completed, failed, cancelled or interrupted; startup interrupts running records
without replaying source or turns. Migration 025 adds `sessions.agent_mode`,
defaulting existing placements to interactive. Migration 026 renames the stored
`scripted` value to `headless` while retaining all placement state and history.
Mode persists across resume and runtime placement switches.

`puddlang/` supervises single-file trusted TypeScript in child processes with
validated IPC. Handles resolve current runtime/placement ownership on each call.
Completion/failure retains agents; cancellation/deadlines stop owned agents and
interrupt pending asks on attached agents. Shutdown interrupts programmes;
ordinary session recovery remains independent. Targets must be existing
registered canonical worktree roots in the run's profile. Accounts resolve from
explicit selection, run default, matching profile default or sole logged-in
candidate; unavailable explicit/default choices never fall back.

The runner imports `puddlang`, `zod` and Node built-ins, strips erasable TypeScript
and stores the default export. Host Node 22.21.1+ is required. Source/results are
bounded to 256 KiB; defaults are 50 turns, 8 agents and one hour (caps 1,000, 32,
24 hours). The host permits 16 active runs; each run allows 64 pending/4,096 total
operations. Programmes have host OS authority, not a sandbox. See
[puddlang](docs/puddlang.md) for the full contract.

```
            spawn                     agent prompt detected
 starting ────────► running ◄───────────────────────────► waiting_input
                      │  ▲                                      │
        process exit  │  │ resume                               │ process exit
                      ▼  │                                      ▼
                    exited ◄────────────────────────────── (same as running)
                      │
   daemon boot finds  │       user archives ⇄ unarchives (worktree kept)
   no live PTY  ──► interrupted ─────────────► archived
```

- `starting` covers worktree creation: the daemon fetches per the fetch policy below and creates the worktree (base resolves to `origin/<base>` when it exists, so sessions never branch off a stale local base). Environment setup then happens **inside the agent session** via onboarding (below), guided by the repo's `onboarding_notes`.
- `starting → running` when the agent's PTY produces first output.
- `running ⇄ waiting_input` has two drivers, hook signals first, regexes as the fallback:
  - **Hook signals (authoritative).** At every agent spawn the runtime owner injects `PUDDLE_AGENT_SIGNAL_URL` + `PUDDLE_AGENT_SIGNAL_NONCE` (a per-runtime secret) into the PTY env; agent hook processes inherit that env and report `POST /agent-signal {nonce, state}` — a nonce-gated endpoint deliberately outside `/api` (the hook has no bearer token; the nonce dies with the runtime). The adapter installs the hooks: for claude-code, `Stop` / `Notification(permission_prompt)` / `Notification(idle_prompt`) → `waiting_input`, and `UserPromptSubmit` / `PreToolUse` → `working` (PreToolUse covers resume-after-approval, which fires no UserPromptSubmit) — written additively into the account config dir's `settings.json` beside a tiny helper, inert outside puddle (status behaviour verified against Claude Code 2.1.219; lifecycle payloads against 2.1.238). A hook signal is accepted even while the row is still `starting`: the first `Stop` can beat Claude's first visible TUI draw. After a session's FIRST status signal, hooks own its status and the regex detector is muted — idle TUI redraws (e.g. a resize on tab open) would otherwise misread as activity with no hook event to restore `waiting_input`.
  - **Regex fallback.** Until a signal arrives (agents without hooks, older CLIs), the adapter's `statusPatterns` are matched against the output stream as before (debounced; `waiting_input` only after ~2 s of quiet following a match).
- Daemon boot first discovers and authenticates independent owners, adopts their retained state and protects unresolved ownership from duplicate launches. Confirmed ended owners and legacy daemon-owned `{starting, running, waiting_input}` rows without a live PTY reconcile to `interrupted`; configured auto-resume governs replacement launches. Reconcile also sweeps the filesystem: a worktree directory with no session row is flagged in the UI (never auto-deleted); a session whose worktree is missing is badged "worktree missing" and cannot resume; a live process can still be stopped, and the placement can be archived.
- **Stale-running (advisory, computed on read like `worktree_missing`).** A `running` agent session whose adapter-reported activity (`adapter.sessionActivityAt` — for claude-code, the transcript's mtime via a cached stat) is over an hour old is flagged `stale_running` on the session shape: the TUI may be redrawing, but the agent has recorded no work — probably a wedged process. The UI fades the session's status indicator (dot or glyph) with a "possibly stalled" hint. Advisory only: a very long tool call looks identical, so the daemon **never** kills, downgrades, or otherwise interrupts a session because of it (decision 2026-07-28).
- `exited` / `interrupted` → `running` via resume (adapter `resumeArgs`, same worktree, same config dir). On resume after `interrupted`, the daemon injects a first message — the profile's **restart launch text** (`profileSettings.restartTemplate`; absent → the built-in default _"This session was interrupted (daemon or machine restart). Processes you started are gone; re-verify your environment before continuing."_, empty string → no note), editable in Settings → Sessions (§4 Launch text).
- `archived` ⇄ `exited`: any non-archived session can be archived in one gesture — a live one (`starting`/`running`/`waiting_input`) is killed by the daemon as part of it — and **archiving is a reversible placement hide, not a teardown**. It changes nothing on disk and archives only that placement; duplicate placements of the native conversation remain exited. Catalogue polling never unarchives it. An exact native `/resume` into that placement does: native intent clears `archived`, adopts the live runtime state, and focuses it. **Unarchive** (`POST /api/sessions/:id/unarchive`, → `exited`) brings it back manually: if the worktree is still on disk the session resumes with its history intact; if it was pruned, or its branch was moved or deleted, the session returns visible for its terminal/conversation history only, with resume disabled through the read-time `worktree_missing` flag. Because nothing is destroyed there is no confirmation and no `force`/`delete_branch`; disk and branch cleanup remain explicit Worktrees actions. Archiving a **project** archives all its sessions and refuses while any is `running`/`waiting_input` unless forced.
- Auto-resume on boot is ON by default (`config.json: autoResume: true`; flipped 2026-08-09 — it shipped OFF): a daemon restart resumes interrupted sessions itself, and any that fail to resume surface in the UI for one-click resume. Settings → Host toggles it.

Desktop menus, tab shortcuts, pane overlays and mobile actions share session lifecycle eligibility. Only exited/interrupted sessions with present worktrees and native conversations can resume. Mobile retains a disabled Resume action with the missing-resource reason; live sessions retain Stop regardless of missing-resource flags. Connection and pending-request restrictions remain local to each surface.

### Native conversation lifecycle

Placement orchestration stays in `sessions/service.ts`; `sessions/legacy/owner.ts`
owns daemon-hosted PTYs, nonce/conversation indexes, status detection, native
rebinding and exit handling. `sessions/environment.ts` and `identity.ts` own
shared shell preparation and native reference/title/adoption work. Launch backend
selection is fixed at service composition. Controls still follow durable current
ownership; an independent launch failure never falls through to an in-process
spawn. The existing lifecycle mutex, maintenance admission and stores retain
placement consistency across these owners.

A live agent is owned by an internal stable runtime identity, not by the placement currently shown in its URL. That runtime owns the agent PTY, shell PTYs, sidecars, captured environment, port roots, signal nonce, and an `activeSessionId`. A keyed mutex serialises native switches and REST resumes, and the daemon indexes runtimes by conversation so at most one Puddle runtime can own a native conversation.

Adapters report exact top-level `SessionStart`/`SessionEnd` transitions through the nonce route. `/clear`, `/resume`, and `/fork` may switch placement; startup binds initial identity and `/compact` remains the same conversation. Reviews, ephemeral Codex threads, OpenCode children with `parentID`, and other child/subagent sessions are excluded. On a switch the daemon resolves or creates the target conversation placement in the **current project and current canonical worktree**, even when native metadata records another cwd. It preserves the target placement's Puddle title, clears `archived`, adopts the runtime's account, environment, permission and sync state, and transfers branch ownership. It then quiesces output, closes the old log/screen segment, marks the old placement `exited`, rebinds agent and shell PTYs to the target, starts the target segment, and forces a full TUI redraw. Native `/new`, `/clear` and `/fork` that switch the foreground conversation retain both conversations: after confirmed placement adoption, the service records one exact source-resume intent and resumes the saved original in an independent runtime through the ordinary admission path, without an injected prompt. It rechecks the original identity and status before dispatch; uncertainty never retries a launch, and a failure leaves the new conversation intact with an explicit notice for the original. Native creations observed during initial owner adoption follow the same path after server composition. Ordinary `/resume` retains switch semantics. Durable events and `session-switched` tell every viewer what happened; only a viewer focused on the source follows automatically. Native creation pins both source and target terminal tabs so preview replacement cannot discard either; only the new conversation becomes focused.

If runtime A switches to conversation B while B already has a live runtime, A is stopped as an expected exit and B is focused instead. A remains visible and exited. When B's placement is in another project, the focused viewer navigates there and uses that project's layout, opening B as a preview only if absent. A REST resume of an already-live conversation returns `409 conversation_live` with structured `existing_session_id` and `existing_project_id`, allowing the same focus behaviour.

Launch is capability-checked. Claude Code and Gemini use additive native hooks; OpenCode installs a Puddle-managed top-level lifecycle plugin; Codex uses a runtime-owned loopback WebSocket proxy between `codex --remote` and `codex app-server`, with the app-server process tree included in port ownership and its bridge ports hidden. Both the remote TUI (`-C`) and app-server process are rooted in the placement's worktree — remote mode delegates workspace creation to the sidecar, so letting that process inherit the owner's home directory silently turns Codex's workspace/footer into `~` and removes its Git branch context even though the PTY itself was spawned correctly. If an adapter's exact channel cannot start, the runtime owner uses its normal direct launch, records `native_sync: 'fallback'`, and adds one restrained terminal warning that in-agent switches will not synchronise. Catalogue discovery continues but never guesses that a runtime changed identity.

### Relaxed isolation: shared branches and directories

**Base branch selection.** An explicit session base branch wins, then the saved repository default. Settings → Projects accepts an empty default (protocol 21.3): resolve the branch currently checked out at `repos.path` under the Git mutation mutex for every new agent or terminal, whether sharing a directory, using a separate directory, or creating a separate branch. Switching branches at the clone therefore changes the next session's default without rewriting the setting or existing placements. Detached HEAD retains the `main` fallback; if that branch does not exist, creation returns the usual `unknown_base` error. An explicit directory to join still wins. The new-session dialogue keeps an automatic base field blank, describes its meaning, and previews the clone's branch without submitting that preview as a fixed branch or directory. Branch hints and project-directory base diffs resolve the same dynamic default. New repositories default to an empty setting, including registration requests that omit it. The new-project dialogue explicitly sends an empty default to hosts supporting protocol 21.3 or newer, including older compatible hosts that would otherwise snapshot HEAD. Non-empty explicit defaults remain fixed. Migration 023 clears all existing repository defaults once (including custom branches), preserving repository ids, other settings, project references and existing session placements. Defaults explicitly set after the migration survive restarts.

Branch-per-session is the default, not a straitjacket. Two **independent** axes on session creation decide where a session lands:

- **`separate_branch`** (default true for agents, false for terminals): a fresh branch — `<branch_prefix><slug>` — checked out in its own new worktree. False works **directly on the base branch** (no new branch; commits land on the shared branch). A `branch` name combined with `separate_branch: false` is rejected (400 `branch_with_shared`).
- **`separate_worktree`** (default true for agents, false for terminals; only meaningful, and only permitted false, when `separate_branch` is false — a new branch always gets its own directory, else 400 `shared_worktree_needs_shared_branch`): whether the session gets its own working directory or shares one. On the base branch, `true` gives each session its **own** directory — a distinct `git worktree add --force` checkout of the base branch, so concurrent agents share the branch (commits interleave) but not the working tree. Turning it off **shares** a directory:
  - `join_worktree: <path>` lands the session in a specific existing worktree of the repo — any entry from `GET /api/repos/:id/worktrees`, validated by realpath against git's own worktree list (400 `unknown_worktree`, `detached_worktree`). This is how a second agent drops into a directory another is already working in.
  - Omitted, it uses the base branch's **default** directory: **the repo's own clone (`repos.path`) when that branch is checked out there** — puddle stays faithful to where the user cloned rather than making a second checkout beside it — otherwise the canonical shared worktree at `worktrees/<repo_id>/branch-<slug>/` (first such session creates it). No worktree is removed on archive (archiving is a reversible hide — §4); worktrees are reclaimed only by an explicit prune in the Worktrees manager (§8).

The shared-directory case is the **default** for both kinds (decision 2026-08-03, reversing the earlier discouraged stance: most sessions want the base branch as-is; separate branch/directory stay one toggle away and `profileSettings.sessionDefaults` re-seeds them per profile). "Use separate directory" is still greyed and forced on whenever "use separate branch" is on, and the shared case still warns that concurrent agents in one directory can and will trample each other's edits, offering a dropdown of directories already on the base branch to join. Only the session that **creates** a worktree receives the onboarding preamble and the `.puddle/onboarding-notes.md` marker-file watch; a session joining an existing directory skips onboarding (the environment already exists, as with resumes and hand-offs) but has its prompt prefixed with a concurrency heads-up — expect the working tree to shift underneath you; avoid disruptive git operations (resets, force-pushes, branch deletion). Archiving never removes a worktree (it is a reversible hide — §4); a base branch is never deleted by puddle (it isn't puddle's), and branch pickers do not badge it as a session branch.

A shared session can use the registered repository's current branch before its first commit (an unborn branch), including in a local-only repository with no remote. Resolve the existing directory before requiring a branch ref; preserve the index and working files, and never create an initial commit implicitly. Creating a separate branch or directory still requires a base ref with a commit.

**Terminal sessions.** A session's `kind` is `agent` (a coding agent driving the worktree) or `terminal` (a plain shell PTY — `$SHELL`, no agent and no account). A terminal is created through the same new-session machinery (`POST /api/sessions {kind:'terminal'}` — no `account_id`), gets a worktree the same way, and appears in the sidebar like any other session, but in **blue** rather than agent amber — a terminal glyph by default, or a detected foreground agent’s brand mark — and with a `terminal` type line rather than an agent/account line wherever full session metadata is shown. It defaults `separate_branch` to **false** (a scratch shell usually wants the branch as-is, not a fresh one); a separate branch is still available. It receives no onboarding preamble, no `.puddle/` marker watch, and no conversation store — there is nothing to onboard or adopt. `account_id`/`agent_type` are null; the permissions gate, migration (§5), and conversation sharing (§S) do not apply. Its PTY runs on the same `agent` term id, so terminal and editor views attach unchanged. Lifecycle is the same state machine: it goes `starting → running` on the shell's first output and `→ exited` when the shell dies; a daemon restart interrupts it like any session, and **resume relaunches a fresh shell in the same worktree** (a shell process cannot be reattached across a restart), keeping it alive from the UI's point of view. Creation accepts an optional worktree-relative `cwd` — the file tree's **Open Terminal in Directory** (§8) — as the initial value. At each subsequent prompt the shell hook reports `PWD`, and the daemon updates the same field, so a resume after a daemon restart returns to the directory the user actually `cd`'d into; extra shell tabs open there too, and the last prompt report wins when several are open. The value stays relative to `worktree_path` so the two cannot drift. A prompt outside the worktree records the safe root fallback rather than an arbitrary absolute path, and a stored directory that has since been deleted likewise falls back to the root instead of making the session unspawnable.

Terminal sessions advertise an optional, transient `detected_agent_type` (protocol 22.1) when a supported agent is recognised in the main `agent` PTY. Each independent terminal runtime takes a bounded asynchronous snapshot of its own main PTY every three seconds. Its monitor caches the verified TTY, reducing steady refreshes to one scoped process scan; every result must still contain the exact root on that TTY. PID/generation changes, missing or moved roots, inspection failure and disposal invalidate the cache. No terminal runtime means no scan. Detection follows foreground process groups and their ancestors on the same TTY, rooted at the exact PTY process, so agent tools retain the outer agent’s mark while background/suspended jobs, extra shell tabs and unrelated terminals cannot claim it. Adapters recognise their executable and known Node/Bun entry points; arbitrary argument mentions, ambiguous pipelines and unavailable inspection retain the terminal glyph. Process arguments stay host-local. Changes invalidate session queries through the existing profile-filtered `sessions-changed` event. Desktop/mobile rails, tab glyphs and tooltips use the hint while retaining terminal-blue status styling and terminal lifecycle/account/conversation semantics. The hint is never stored in SQLite, and clears on agent exit, suspension, inspection failure or PTY shutdown; resumed shells are inspected afresh. This is best-effort local-host detection, not introspection inside SSH, containers or tmux.

**Session shell history.** Every shell tab spawned inside a Puddle session uses one durable history file under that session's private log directory; tabs in the same session share it, while other Puddle sessions, the home terminal, login terminals, and shells outside Puddle do not. The zsh and bash shims establish the private history context **before** sourcing the user's normal rc, so ZLE/Readline widgets, environment managers, and prompt frameworks initialise against the final history rather than having it replaced underneath them. At each prompt they reassert the private `HISTFILE`, then append only that tab's completed commands without rewriting the shared file; this recovers from directory hooks, environment activation, or prompt integrations that repoint history at runtime. Bash also imports sibling-tab appends live, while zsh loads the shared file when a tab or shell starts rather than mutating ZLE's history underneath an active editor. Up/Down recall therefore survives activation, extra tabs, and shell/daemon restarts. An rc that deliberately reads a different history file may add those commands to the in-memory list, but persistent writes remain private. Bash 3.2 retains cwd/history support even though it cannot capture exported env. Unsupported shells receive the session `HISTFILE` as a best effort but have no prompt hook.

Environment setup is not deterministic per repo — whether _this particular worktree_ needs a fresh `.venv`, a symlink to a shared one, or none at all is often the user's call in the moment. So setup is split into **standing rules** and **per-worktree discretion**:

1. **Standing rules — `repos.onboarding_notes`.** A user-authored, freeform text block per repo (editable in the Projects settings tab, which holds per-repository settings), holding whatever the user has decided is always true: "always `pnpm install`", "shared `.venv` lives at `<repo>/.venv`; symlink it unless I say otherwise", "never install playwright browsers", "ask me before touching Docker". Empty is fine — everything is then discretionary.
2. **Every freshly created worktree onboards — and only those.** The daemon prepends an _onboarding preamble_ (the profile's **launch text**, see below) to the agent's first prompt (or delivers it alone when the session was started without a task prompt): read the notes; inspect the codebase for setup requirements (README/CONTRIBUTING, lockfiles, `.tool-versions`, `pyproject.toml`, …); **apply what the notes settle without asking; ask the user about anything the notes leave open** — stating trade-offs where relevant (a symlinked `.venv` saves gigabytes per worktree, but parallel sessions then share mutable dependency state). Execute only what the notes prescribe or the user approves, then proceed to the user's actual task. Sessions that _reuse_ an existing worktree — resumes, and tier-2 hand-offs (§5) — never receive the preamble; their environment already exists, and the resume note or hand-off prompt takes its place. The launch text is **editable per profile** (Settings → Sessions), with three templates: one for a freshly created worktree — where a `{{rules}}` token is replaced with `repos.onboarding_notes` — one for joining an existing/shared worktree, and one sent when a session is **resumed after a daemon restart or machine reboot**; any may be cleared to send no preamble, defaulting to the built-in text (`profileSettings.onboardingTemplate` / `concurrentTemplate` / `restartTemplate`; absent → default, empty string → intentionally empty).
3. **Rules can be taught through the agent.** If during onboarding the user states a standing rule ("always do X from now on"), the preamble instructs the agent to write the updated notes to `.puddle/onboarding-notes.md` in the worktree; the daemon syncs that file into `repos.onboarding_notes` and confirms with a toast. Syncs are last-writer-wins (several sessions can onboard concurrently), so the daemon logs the previous notes to `events` and the toast links the change — an unwanted overwrite is one click to inspect and revert. The notes remain user-owned prose — the agent records decisions, it doesn't invent policy. (`.puddle/` is git-excluded, never committed.)
4. **Placements keep Puddle names; conversations keep native names.** A session's display name is `title ?? agent_title ?? <id-prefix>`. `title` is the placement's user override (`PATCH /api/sessions/:id`), so the same native conversation may be labelled differently in different projects. `agent_title` is the joined `agent_conversations.native_title` — for Claude Code, the transcript's `agent-name`/`ai-title`; for Codex, `threads.name`. Adapter point refreshes still run on status/exit/OSC cues and periodically, while catalogue scans catch changes in inactive conversations without reading transcript bodies. An empty UI title clears only the Puddle override. Native-title refreshes broadcast `renamed` for the live placement and catalogue scans broadcast `sessions-changed` for every affected project; user overrides continue to win. The git branch is fixed at placement creation and never renamed by either title path.

Notes are **repo-global, shared by all profiles** — like the repo itself on a trusted box. Genuinely personal preferences are expressed in the moment (per-worktree answers); if that proves noisy in practice, a per-profile notes addendum is a natural later extension, deliberately not in v1.

The prescriptiveness of the notes is the automation dial: exhaustive notes make onboarding near-silent (the agent just executes and gets on with the task); sparse notes mean a question or two per worktree — which is exactly right when the answer genuinely varies per worktree. Onboarding runs under the session's normal permission rules — the gate (§11) is not bypassed for setup.

### Captured session environment

`export FOO=bar` typed in a session terminal — or exported by a `source`d script, `nvm use`, `.venv/bin/activate` — persists for the session: it is re-injected into every future PTY spawn on that session (new shell tabs, agent restarts and resumes, respawns after a daemon restart). Scope is strictly per-session; the `home` stream and `login-*` PTYs have no session row and are excluded.

- **Capture** is part of the injected session-shell prompt hook, since a parent process cannot read a child shell's exports. Session shells spawn with a shim — zsh via a `ZDOTDIR` shim directory whose zdot files chain to the user's real ones then register a `precmd` hook (the user's ZDOTDIR view is restored after rc, so `exec zsh`, nested shells, and children never see the shim); bash via `--rcfile` (sources `~/.bashrc`, then prepends to `PROMPT_COMMAND`). At each prompt, when capture is enabled, the hook diffs the shell's exported env against an in-memory baseline seeded **after** the user's rc ran — so rc-set exports and re-injected captured vars are baseline, not deltas (no feedback loop) — and reports changes. Because it diffs the _result_, `source`, `eval`, and tool shims are all captured. Unsupported shells (fish, …) and bash < 4 (macOS `/bin/bash` 3.2 lacks associative arrays) have no env capture; injection still applies, while bash retains the hook's cwd/history duties. Independent runtimes pin their hook scripts under `~/.puddle/runtimes/<runtime-id>/shell-hooks/` before dispatch; later daemon builds never regenerate that tree (0600 files, 0700 dirs). Daemon-owned terminals retain the shared `~/.puddle/shell-hooks/` directory. Capture is best-effort: an export with no subsequent prompt (`export X=1 && exit`) is missed, and a plugin that wholesale-resets the prompt hook arrays disables it silently.
- **Transport** is OSC 7733, a puddle-internal terminal side-channel: one `ESC ] 7733 ; set ; b64(name) ; b64(value) BEL|ST` (or `unset ; b64(name)`) sequence per changed var, plus `cwd ; b64(absolute-path)` when `PWD` changes — base64 so newlines and quoting survive byte-exact. The runtime owner parses and **strips** these at its PTY-output choke point, before the log append and any broadcast, so private payloads never reach terminal recordings, replay, or viewers.
- **Persistence and merge**: owners retain private observations and send ordered journal events to the daemon, which commits `sessions.session_env` before acknowledgement (SQLite is the application source of truth). Merge is per-variable in arrival order — last write wins across a session's terminals (two shells in different dirs under direnv will ping-pong; accepted). `unset` removes a captured name only; there are no tombstones over daemon-baseline env, so a var the daemon itself provides cannot be persistently unset. Caps: 32 KiB per value, 128 vars per session — overflow is dropped with a one-time `[puddle]` note in the reporting terminal. A denylist (`PWD`, `HISTFILE`, `SHLVL`, prompt machinery, identity vars, `ZDOTDIR`, the `PUDDLE_*` prefix, …) is filtered in the hook and re-checked by the runtime owner; `PATH` is deliberately capturable (venv/nvm is the headline use case). Archive does **not** clear the map (unarchive + resume restores the working environment); `DELETE /api/sessions/:id/env` is the manual purge.
- **Injection order** at spawn is `process.env` → captured vars → adapter/hook-control env, so adapter env (e.g. `CLAUDE_CONFIG_DIR`) always wins. Captured env reaches agent PTYs as well as shells.
- **Gate**: the per-profile `captureSessionEnv` setting (default **on**, Settings → Sessions). Off makes env capture dormant — no env reports, deltas ignored, no re-injection — with the stored map kept for re-enabling. The session-shell shim remains for cwd tracking and isolated history.
- **Secrets posture**: values live in private runtime launch/journal records and `~/.puddle/puddle.db`, inside the 0700 puddle home — the same trust domain as the daemon token. There is no at-rest encryption by design: a co-located key adds nothing, and headless daemons have no keychain. Typing `export FOO=secret` lands in the session's private shell-history file in plaintext; the OSC strip keeps values out of terminal logs. The authenticated API returns each captured value to the cockpit (optional `value` since protocol 16.2); clicking a name copies its value without displaying it. This adds no privilege to a cockpit that can already send `echo "$NAME"` to the session PTY and read the result, while keeping passive display and logs value-free. A worktree process can forge OSC 7733 and poison a future spawn's env — but it already runs arbitrary code as the user, so no privilege boundary is crossed.

### Fetch policy

Base-branch freshness is treated as ambient hygiene, not a user chore. The daemon runs `git fetch` (fetch only — worktrees and local branches are never mutated):

- **on session creation** (before branching, as above),
- **on project open** (any client loading `/project/:id`),
- **periodically** in the background — `config.json: fetchIntervalMinutes`, default 15 — for every repo with at least one non-archived session.

All fetches use the OS user's normal git credentials, are serialised through the per-repo mutex, and update `repos.last_fetched_at`. Per-repo opt-out (`fetch_enabled = 0` — disables create-time, open-time, and periodic fetching alike) exists for air-gapped boxes. For repos with no remote, fetching and freshness indicators degrade silently (ahead/behind is computed against the local base). Otherwise the UI shows each session's ahead/behind counts against `origin/<base>` and a subtle "base moved" indicator when the base branch has advanced since the session branched — surfacing drift early instead of at merge time. Fetch failures (offline, auth) are logged and shown as a muted repo badge; they never block session creation.

## 5. Agent adapters

The core is agent-agnostic. Each agent owns a folder in `packages/daemon/src/agents/<id>/`, with `index.ts` implementing the adapter and neighbouring modules for native integrations, storage and control implementing:

```ts
export interface SessionRefContext {
  sessionId: string; // puddle session id
  worktreePath: string;
  createdAt: string; // immutable sessions.created_at anchor
  nativeCreatedAt?: string; // catalogue's native creation time, when known
  excludeRefs?: ReadonlySet<string>; // refs proven to belong elsewhere
}

type StorageLookup<T> = T | Promise<T>; // account-wide reads may yield

interface NativeConversation {
  ref: string;
  cwd: string;
  title: string | null;
  parentRef: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AgentAdapter {
  id: string; // 'claude-code', 'codex', 'opencode', 'gemini-cli'
  displayName: string;
  binary: string; // executable name to resolve on PATH
  matchesProcess?(command: string): boolean; // advisory foreground-agent icon detection
  scriptedTurns?: boolean; // adapter support; runtime/version checked separately
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
  // Guidance the login dialogue shows verbatim (13.1) — for a flow that is not
  // self-evidently finishable. claude-code, codex, and gemini-cli all run
  // their FULL TUI so the agent's own first-run sign-in screen renders in the
  // PTY (claude's method picker; codex's — its `login` subcommand only opens
  // a browser + localhost callback on the daemon host, an empty panel from a
  // remote cockpit; gemini has no auth subcommand at all), then must be
  // exited by hand — which the hint says. opencode keeps `auth login`, an
  // interactive picker that exits cleanly on its own. A clean exit is
  // VERIFIED via checkLoggedIn where one exists, never assumed, since
  // quitting a TUI without signing in also exits 0.
  loginHint?: string;
  // Minted-id adapters snapshot every ref already present in the cwd before
  // launch; the core serialises snapshot → spawn → resolve per account/cwd.
  existingSessionRefs?(worktree: string, account: AccountRow): StorageLookup<ReadonlySet<string>>;
  // Returns the agent-native session ref. Either echoes the preset id, or
  // discovers a post-launch ref that was absent from the snapshot.
  resolveSessionRef(
    opts: LaunchOpts,
    account: AccountRow,
    excludeRefs?: ReadonlySet<string>,
  ): Promise<string>;
  // Creation-time recovery for a missing, duplicated, or mismatched stored ref.
  discoverSessionRef?(
    worktree: string,
    account: AccountRow,
    context?: SessionRefContext,
  ): StorageLookup<string | null>;
  sessionRefMatches?(
    ref: string,
    context: SessionRefContext,
    account: AccountRow,
  ): StorageLookup<boolean>;
  // Legacy point lookup used by live title/activity refresh paths. Public
  // agent_title is stored once on agent_conversations and joined to placements.
  sessionTitle?(ref: string, account: AccountRow): string | null;
  conversationDiscovery?: {
    watchRoots(account: AccountRow): string[];
    discover(account: AccountRow): Promise<NativeConversation[]>;
  };
  lifecycleSignals?: boolean;
  checkLifecycleSupport?(account: AccountRow): Promise<boolean>;
  prepareLifecycleLaunch?(context: LifecycleLaunchContext): Promise<LifecycleLaunchResource>;
  // Move a conversation's on-disk state from one account's config dir to another's
  // (same agent type). Only called when capabilities.migratableSessions.
  migrateSession?(ref: string, from: AccountRow, to: AccountRow, worktree: string): Promise<void>;
  // Render the conversation as readable text (for cross-agent hand-off). Falls back
  // to the puddle PTY log tail when the agent's native format can't be parsed.
  exportTranscript?(ref: string, account: AccountRow, worktree: string): Promise<string>;
  statusPatterns: { waitingInput: RegExp[]; busy?: RegExp[]; limitReached?: RegExp[] };
}
```

`statusPatterns` are matched against the output stream **after stripping ANSI escape sequences** — agent TUIs colour their prompts, and regexes written against clean text silently never match raw PTY bytes. They are the FALLBACK status driver: an adapter that can install agent hooks (claude-code — `claude-code/hooks.ts`) gets authoritative hook signals via `POST /agent-signal` instead, and the regexes only drive status until the session's first signal (§4).

Capability notes per adapter (**verify every flag against the installed version during Phase 1/7 — agent CLIs change fast; encode findings in the adapter, never in core**):

- **claude-code**: isolation via `CLAUDE_CONFIG_DIR`; supports `--session-id <uuid>` at launch (→ `presetSessionId: true`) and `claude --resume <uuid>`; skip mode `--dangerously-skip-permissions`; conversations stored as JSONL under `<config_dir>/projects/<escaped-cwd>/<uuid>.jsonl`. Additive `SessionStart`/`SessionEnd` hooks report startup/resume/clear/fork/compact identity (lifecycle payloads verified against 2.1.238) alongside the existing status hooks.
- **codex** (flags, storage, and app-server lifecycle re-verified against codex-cli 0.147.0; live idle signature against 0.146.0): isolation via `CODEX_HOME` alone, which relocates config, sessions and credentials together. Conversation state is split: rollouts live at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, while `$CODEX_HOME/state_<n>.sqlite` indexes the same threads. The first rollout `session_meta` carries the session `id`, `cwd`, creation timestamp, and (for child agents) `parent_thread_id`; the SQLite row carries the id/cwd/time sooner, before a large rollout header is necessarily readable. Resume `codex resume <id> [prompt]` (or `--last`); bypass `--dangerously-bypass-approvals-and-sandbox` — **`--yolo` does not exist in 0.147.0** despite older published docs. `codex login status` exits non-zero when logged out, so the exit code alone drives `checkLoggedIn`. Session ids are not presettable, so `presetSessionId: false` and `agent_session_ref !== sessions.id` — the first adapter where those diverge. Before launch puddle snapshots the account/cwd's existing top-level refs, then reads the state index first for a new one while excluding that snapshot; child threads are never eligible. A missing, incompatible, or stale index falls back to an asynchronous rollout index that reads only each file's bounded `session_meta` header and caches unchanged metadata — it never synchronously loads whole transcripts. This snapshot → spawn → capture sequence stays serialised per account/cwd, but yields a full event-loop turn and runs behind the session-create response: the browser can attach immediately without native-ref discovery blocking any API or PTY. Concurrent late-capture ticks share one lookup. An unresolved placeholder is never stored; status changes and the periodic title refresh retry the same creation-time-safe discovery. On resume, a ref must be the unique closest match to the Puddle session's cwd and native conversation creation time when catalogued, falling back to the immutable placement creation time for legacy rows; this prevents a real but unrelated rollout from hijacking the row without rejecting a conversation merely because its placement was materialised later. The v0.0.56 bridge briefly wrote exact refs under the daemon cwd; when a normal cwd lookup finds nothing, resume compatibility accepts only the unique account-wide top-level ref born in the same creation window, retaining the concurrent-launch ambiguity guard. The UUID remains stable when Codex renames a thread: catalogue discovery re-reads `threads.name` as the native title without rewriting the ref. Exact switching comes from successful top-level `thread/start`, `thread/resume`, and non-ephemeral `thread/fork` JSON-RPC responses through the app-server bridge. Both sides of that bridge are explicitly rooted at the Puddle worktree (`-C` on the remote TUI and `cwd` on app-server), rather than relying on the daemon process's directory. Its live idle composer renders as `› … <model> · <directory>` after ANSI stripping; that observed signature, not the absent `? for shortcuts` string found in the binary, remains the fallback for `waiting_input`. Native app-server `turn/started` and `turn/completed` notifications (schema checked against 0.157.1) drive the exact active conversation’s status when available, serialised after its placement binding; side threads are ignored.
- **opencode** (verified against opencode 1.18.10): isolation needs **all four XDG roots** — `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` — because `auth.json` and the session store live under the DATA root, not the config one. `OPENCODE_CONFIG_DIR` relocates _nothing_ (verified with `opencode debug paths`) and is useless for account isolation. Resume `--session <ses_id>`; skip mode is `--auto`, so `skipPermissions: true`. Like Codex, OpenCode mints ids, so launch captures a ref absent from the pre-launch account/cwd snapshot and resume validates/re-recovers it from the stored creation time. Its SQLite catalogue reads metadata in yielding pages with zero lock wait, supports V1 and V2 tables, and retains V2 fork ancestry; unavailable or incomplete reads never confirm deletion. Legacy JSON discovery remains asynchronous, caches files by size and modification time, and coalesces concurrent polls. A Puddle-managed plugin reports only top-level session lifecycle/status events and ignores events whose session has `parentID`. `opencode export <id>` yields the transcript. Caveat: redirecting `XDG_CONFIG_HOME` also hides an XDG-located global gitignore from git commands the agent runs; identity is unaffected (`~/.gitconfig` is HOME-based).
- **gemini-cli** (verified against @google/gemini-cli 0.53.1): isolation via **`GEMINI_CLI_HOME`**, which the CLI checks before `os.homedir()`; state lands at `<config_dir>/.gemini/`. The widely cited `GEMINI_CONFIG_DIR` is ignored and would leave the CLI writing into the user's real `~/.gemini`, breaching §2. `--session-id <uuid>` presets the id (`presetSessionId: true`); resume `--resume <ref>`; skip mode `--approval-mode yolo`. `--prompt` is headless and exits, so an initial prompt must use `--prompt-interactive`. It has **no `auth` subcommand**, so login is a bare launch into the first-run picker and `checkLoggedIn` inspects the credentials file. Additive `SessionStart`/`SessionEnd` hooks report native identity without replacing user hooks.

Codex fallback status checks the existing canonical screen after output has been quiet
for two seconds. It reads a bounded visible tail, including the footer below the cursor,
and recognises the composer only when no live interrupt spinner is present. Native turn
signals remain authoritative. Stale, missing or failed screen reads never establish
completion; this observation neither resizes the terminal nor creates another parser.

Codex terminal clipboard delivery is verified against 0.157.1: outside tmux, after a successful native host clipboard write it emits OSC 52 only when `SSH_TTY` or `SSH_CONNECTION` is present. The adapter supplies an empty `SSH_TTY` when absent, preserving any inherited value, so browser viewers receive the copy even under a supervised daemon without SSH environment variables. The separately spawned lifecycle app-server keeps its own environment; direct fallback launches also pass the marker to their embedded backend. This compatibility setting takes effect on launch/resume and requires an updated host daemon; a UI refresh cannot retrofit it into a running Codex process. Codex may still report “host clipboard” even when it also sends OSC 52. See `docs/reports/2026-09-26-codex-clipboard.md` for the live binary and browser verification.

Codex legacy recovery treats its current SQLite state index as fast but not exhaustive: catalogue and resume merge it with top-level rollout metadata. A chat omitted from SQLite until Codex's own `/resume` opens it therefore remains present in Puddle. If the old remote bridge recorded its cwd as the daemon home, recovery may search the account rather than the worktree, but accepts only the unique top-level thread born in the Puddle session's creation window; subagents, refs already owned by another session, and ambiguous concurrent launches remain ineligible.

All four adapters declare exact native lifecycle integration, while status integration remains independent: Claude Code's status hooks are authoritative and Codex, OpenCode, and Gemini still use `statusPatterns`. Codex's pattern is verified against a live logged-in 0.146.0 PTY; OpenCode and Gemini CLI remain best-effort until their logged-in acceptance runs. `docs/acceptance/phase-7-agents.md` carries the evidence and remaining checks.

When a capability is `false`, degrade gracefully: e.g. no `resume` → offer "new session in the same worktree", pre-filling a prompt that summarises the branch state (`git log --oneline base..HEAD` + `git status`).

Adding an agent = adding one file + registering it; PRs adding adapters must not touch core session logic.

Conversation identity is unique by `(profile_id, agent_type, agent_session_ref)`, not account: accounts in one profile may expose the same native store. A conversation has at most one placement per `(project, canonical worktree)`, but may appear in several projects that register the same repository. Ref recovery uses the catalogue's `native_created_at` when known, otherwise the Puddle row's immutable `created_at`, together with cwd and the pre-launch ref snapshot; it never guesses “newest in this directory”. If no creation-time match exists, resume fails visibly rather than opening an unrelated conversation.

Claude reference recovery reads only a 16 KiB transcript prefix per candidate,
using asynchronous directory/file access. Account usage observation streams native
JSONL in 64 KiB reads; oversized records retain only usage fields rather than
message content. Concurrent reads of one account coalesce. Unchanged totals use
file identity, size, mtime and ctime; changed files are rescanned without assuming
append-only writes. An observation changed during reading is not cached. Partial
or malformed records do not hide later valid records, and replacement/truncation
invalidate old totals. Cache eviction never truncates history or changes totals.

### Native catalogue discovery and battery budget

Each adapter's `conversationDiscovery` returns only normalised metadata — ref, cwd, title, parent ref, and native timestamps — using asynchronous, cached, bounded reads. Discovery never reads transcript bodies. The coordinator maps native cwd to its containing canonical Git worktree, then creates an exited, unarchived placement in every eligible project: same profile as the conversation account, same registered repository, non-archived project, and a worktree exposed by that repository. It never crosses profiles or imports into archived projects; unarchiving a project immediately makes it eligible and schedules discovery. Polling updates native titles and existence but never unarchives a placement or grants branch ownership.

Opening or transitioning to a project calls `POST /api/projects/:id/conversations/refresh`. The call returns `204` immediately; concurrent requests coalesce by account while the daemon scans and broadcasts `sessions-changed` for created, recovered, missing, renamed, or re-parented placements. This is activation-driven rather than another browser interval.

Eligible accounts install adapter-declared `fs.watch` roots with per-store debounce. Healthy watchers get one unref'd five-minute safety sweep. A failed/unavailable watch falls back to an asynchronous fingerprint poll beginning at 15 seconds and doubling while unchanged, capped at five minutes. In-flight scans coalesce, metadata fingerprints/cache entries are reused, and accounts with no non-archived eligible project install no watchers. Native deletion is confirmed only after two successful scans (a watch deletion schedules a short verification); a failed scan never advances missing state. Missing placements remain visible with a badge and cannot resume, and reappear immediately after a successful scan sees the conversation again.

**Catalogue presence observations**: a complete native-conversation scan shares one observation timestamp between metadata ingestion and presence confirmation. Completion does not rewrite already-observed rows or replace newer lifecycle timestamps. Missing conversations still require two successful observations, and reappearing conversations clear missing state immediately.

Metadata ingestion runs in one synchronous SQLite transaction per accepted scan, before asynchronous Git mapping. Unchanged native fields receive only a presence update; a failed batch rolls back before publication, and newer lifecycle observation timestamps survive ingestion as well as completion. Codex retains complete dated-tree discovery and merges historical rollouts omitted by its native index; file timestamps are read asynchronously in batches of at most 32. This avoids synchronous per-file work without introducing an incomplete scan or stale worktree cache. Optional internal scan diagnostics report trigger, row count and phase durations only, with no conversation identities or content.

### Errors are never silent

A failure the user cannot see is a bug. Two mechanisms guarantee they surface:

- **Login verification is pushed.** A login PTY's clean exit only _starts_ the answer: the daemon asks the adapter's own auth check (`checkLoggedIn`) and records the verified flag afterwards — asynchronously, once the login dialog has already closed, when no request is in flight to carry the result back. Whenever `setLoggedIn` actually changes the stored flag, the daemon broadcasts an **`account` WS message** (`account_id`, `profile_id`, `logged_in` — protocol 15.1) to every status subscriber, and the UI patches its cached account lists in place, so the settings badge goes green the moment verification lands rather than on the next unrelated refetch.
- **Abnormal PTY exits raise a `notice`.** When an agent or shell exits non-zero without having been asked to, the daemon emits a `notice` WS message (`level`, `title`, and `detail` — the ANSI-stripped tail of whatever the process printed). It is broadcast to **every status subscriber**, not just clients attached to that stream, because the user is usually looking at another tab; the UI renders it as a toast. An exit within `STARTUP_FAILURE_MS` of spawn is titled "failed to start" — the flag-drift and bad-credential case — and the process's own error text is normally the entire diagnosis. Note that the session _status_ cannot classify this: a launch error printed to the terminal is output like any other, so it flips the session to `running` on the way out.
- **Nothing fires for a stop we asked for.** `kill`, `archive` (which kills), a `kill-shell` request, and daemon shutdown mark the stream as an expected exit, consumed by the matching exit. A notice the user learns to ignore is worse than no notice.

Client-side, every mutation is covered by a global handler, so an action can never fail silently because its call site forgot one; local handlers still run for their side effects and report through the same helper, whose message-derived toast id collapses the pair into a single toast.

### Is the agent even installed?

`binary` is resolved on the daemon's PATH (already extended with `config.agentPath` at boot — §11). Nothing may spawn an agent without checking it first: node-pty does **not** fail loudly for a missing executable — on macOS its spawn-helper `execvp`s and returns 1 — so an absent CLI otherwise produces a PTY that dies instantly with no output. A login dialog then flashes open on an empty terminal and vanishes, and a session goes `starting → exited` with nothing to explain why.

`assertBinaryAvailable` (`agents/binary.ts`) therefore guards login, session create/resume, migration and hand-off, rejecting with **`424 agent_not_installed`** and a message naming both the executable and the `agentPath` setting. It runs **before** `checkLoggedIn` everywhere, and the boot re-verification sweep skips uninstalled agents: adapters answer `checkLoggedIn` by asking their own CLI, so an absent binary reads as "logged out" and would otherwise clear a perfectly good `logged_in` flag. Lookups are cached for 30 s, so installing an agent mid-session un-sticks the UI without a daemon restart.

`GET /api/agents` reports `binary` and `available` per adapter so the UI disables the add-account and login affordances up front, with a plain inline note, rather than letting the user click into a guaranteed failure. Both fields are optional on the wire; a daemon that omits them is assumed available.

### Continuing work across accounts and agents

Two tiers, surfaced as one "Continue on…" action in the session menu (and offered proactively when `limitReached` fires — see below):

- **Tier 1 — same agent, different account (migration).** The conversation does **not** move on migration — it already lives in the profile's **shared conversation store** and is reachable from every account. Migration then stops the session's process (it has usually already exited — credit exhaustion), updates `sessions.account_id`, and runs the normal resume path with account B's env; same worktree, same branch, same conversation, different credentials, recorded in an `events` row. Implemented as `POST /api/sessions/:id/migrate {account_id}` (§6) with a strict fall-through: (a) the target reads the conversation through the shared store's symlink → no files move; (b) otherwise, an agent that implements the `migrateSession` adapter hook copies its state across (rolled back on a later resume failure); (c) neither → `409 migration_unsupported`. Only (a) is used for claude-code — the shared store supersedes its (still-declared) `migrateSession` capability, kept for agents whose state can't be shared this way. **Ancillary caveat:** per-account state that is _not_ part of the conversation dir does not migrate — for claude-code the `todos/<uuid>*.json` list stays with the origin account (pinned in `claude-code/share.ts`); a migrated session resumes its full transcript but may lose its todo list, which the agent rebuilds.

  Independent runtimes use the same migration flow in `sessions/migration/`. Validate the target login before stopping the exact source owner; require its committed clean exit, including PTYs and provider resources, before copying state or changing account. Recheck source placement/native ref, both accounts, profile authority and permission policy across asynchronous work and immediately before replacement launch intent. A lost stop reply is observed rather than resubmitted. Copy rollback is allowed only while no replacement launch has been admitted; a failed or unconfirmed admitted launch retains its target account and copied data for inspection. Shared-store failures retain the existing explicit-resume behaviour. Legacy and already-exited placements share the same provider-owned availability paths.

  **Shared conversation store (Workstream S).** For agents whose conversations live in per-conversation directories (claude-code: `<config_dir>/projects/<escaped-cwd>/`), puddle adopts each such directory into a per-profile canonical store at `profiles/<id>/sessions/<agent_type>/<store-key>/` the first time it appears on disk (adopt-after-first-write, on the session's first `waiting_input`), leaving an absolute symlink at the original location and **mirroring** the same symlink into every other account of that (profile, agent). The store-key is the basename of the agent's own conversation dir — for claude-code that name is escaped from the MAIN repository root, so one canonical dir may span a repo's worktrees. All agent-specific mechanics (where the store dirs are, which files belong to a conversation, which are per-account ancillary state like `todos/`) live behind an adapter `conversationShare` hook group; the manager (`ConversationShare`) is agent-agnostic and serialises every filesystem mutation under a `share:<agent>:<profile>` mutex. Creating an account **backfills** it with symlinks to the profile's existing conversations (folding in a real dir an imported config brought along); boot **reconciles** links (repairing missing ones, dropping dangling ones); archiving a session keeps its conversation (archiving is a reversible hide — §4), so an unarchive can resume it; deleting an account removes its config dir — which unlinks its symlinks without following them, leaving the shared store and its siblings intact. Consequence: after adoption every account of a profile reads the same conversation history through its symlinks, so per-account agent-usage token totals reflect the profile's shared conversations rather than one account's slice. Verified against Claude Code 2.1.209 that `--resume` reads a conversation through a symlinked `projects/<dir>`; the full two-account tier-1 flow is a Task 18 acceptance item.

  Codex, OpenCode, and Gemini CLI do **not** use that symlink store: their state is not a self-contained per-conversation directory (Codex, for example, combines date-bucketed rollouts with account-local indexes). Their account config dirs therefore remain isolated, and same-agent cross-account migration stays unsupported until an adapter can move or share the agent's complete state safely. Puddle's own restart resume uses the exact recorded agent session ref and does not depend on the agent's picker.

- **Tier 2 — different agent (hand-off).** No shared conversation format exists, so the conversation is _summarised, not moved_: a new session is created in the **same worktree** on the target agent/account, seeded with a hand-off prompt built from the source adapter's `exportTranscript` (tail-truncated to 12 000 characters, so recent turns survive), plus `git log --oneline base..HEAD` and `git status` — appended after the truncation so the git context is never what gets cut. Adapters without `exportTranscript` fall back to the session's recorded PTY output, ANSI-stripped; that fallback is core, not per-adapter. Degraded by design — the new agent knows _what happened_, not the old agent's private reasoning (thinking blocks are dropped and tool runs collapse to a count) — but the working tree, branch, and task context carry over completely.

  Implemented as `POST /api/sessions/:id/handoff {account_id}` (§6), which **returns the new session, not the one in the path** — the reason it is a separate endpoint from `/migrate` rather than a same-agent/different-agent branch of it. The new session reuses the source's directory through the existing `join_worktree` path, so no second `git worktree add` happens and the reuse correctly skips onboarding. The source session is **left running and untouched** (an earlier draft of this section said it "remains in its terminal state"; hand-off does not require it to have exited), and the pair is linked by `handed_off_to` / `handed_off_from` event rows rather than a new column.

**Limit detection**: adapters may provide `limitReached` patterns (e.g. Claude Code's usage-limit message). On match, the session is badged in the sidebar and the notification (Phase 8) offers "Continue on…" directly — turning the out-of-credit moment from a dead end into two clicks.

## 6. API surface

Lifecycle launch resources may expose `AgentControl`: `ready` and
`ask(prompt, signal, outputSchema?)`. All four provider folders own interactive
and headless launch resources. Interactive is the default: Codex 0.159.0+ uses
its TUI app-server proxy; Claude Code 2.1.300+, OpenCode 1.18.10+ and Gemini CLI
0.53.1+ use native hooks/plugins with exact prompt hashes/turn markers and bounded
assistant replies. Human input/native switches reject pending hook-driven asks;
busy runtimes and existing drafts reject new asks. Claude/Gemini completion is a
native hook boundary; other user hooks can request further work afterwards.

Headless mode runs the actual CLI's structured non-interactive interface inside
a persistent transcript PTY. The adapter owns flags, account isolation and native
JSON parsing; shared `agents/headless/` owns transport, bounds and process cleanup.
Each ask resumes the exact recorded native conversation and requires a native
success result plus exit zero. Ctrl+C cancels the active process group. Mode
selection never enables bypass flags. `spawn({mode})` is internal to Puddlang;
ordinary REST session creation stays interactive. Headless launch failures cannot
fall back to a different mode. Fallback interactive runtimes have no Puddlang
control channel. Catalogue discovery stays metadata-only and never binds a
headless runtime. See [the usage guide](docs/puddlang.md) for mode limitations.

All REST endpoints are JSON under `/api`. Request/response shapes live as zod schemas in `packages/shared` and are the single source of truth for both daemon and UI.

```
Storage    GET  /api/storage                 # local/SSH host storage and persistence health
Version    GET  /api/version                 # {version, protocol: {major, minor}} — the handshake endpoint (see Protocol versioning below)
Puddlang   GET  /api/puddlang/:profile/context
           POST /api/puddlang/:profile/runs      # source/input, UUID, accounts/limits; 202 run record
           GET  /api/puddlang/:profile/runs/:id
           GET  /api/puddlang/:profile/runs/:id/events?after=0   # pages of up to 100 events
           POST /api/puddlang/:profile/runs/:id/cancel
                # protocol 24.0; local/SSH only, excluded from remote leases and relay allowlist
           GET  /api/puddlang/:profile/runs/:id/outcomes?after=<operation-id>  # 26.1; bounded metadata
           POST /api/puddlang/:profile/runs/:id/outcomes/:operation          # 26.1; exact read/discard fingerprint
Signal     POST /agent-signal {nonce, state} | {nonce,event,agent_session_ref?,cwd,source,parent_agent_session_ref?,native_title?,native_created_at?,native_updated_at?}
                | {nonce,event,agent_session_ref,turn_id,prompt_hash?,reply?,error?}
                # status, lifecycle or bounded turn side-channel (§4), OUTSIDE /api: no bearer;
                # per-runtime nonce is auth, 404 on unknown/stale; never proxied by cockpits
Profiles   GET  /api/profiles                POST /api/profiles {name, branch_prefix?}   # ids are 10-hex handles, like projects
           PATCH /api/profiles/:id {name?, branch_prefix?}   # rename (display label, UNIQUE → 409) and/or set branch prefix; dirs are id-keyed so a rename touches nothing on disk
           DELETE /api/profiles/:id                  # 409 while sessions are non-archived or puddlang runs are active; cascades rows + removes its dir
           GET  /api/profiles/:id/settings   PATCH (profile-scope settings JSON — §11 Settings)
           GET  /api/profiles/:id/state      PUT (the profile's ui_state JSON — one workspace shared across its projects; debounced writes; 404 no_state until first write, no cross-profile seeding — §11)
           POST /api/profiles/:id/untitled   # new worktree-agnostic draft in profiles/<id>/untitled/ → {name: untitled-<n>.md} (10.3, §8)
           GET  /api/profiles/:id/untitled/:name   PUT {content}   DELETE      # draft content round-trip; the name pattern is the traversal guard
Config     GET  /api/config                  PATCH (daemon-scope settings; affects all profiles; the port lives in config.json / --port only and is never surfaced in the UI)
Host       GET  /api/host                    # daemon identity {username, hostname, home, displayName?} — the UI's location indicator; displayName is config.json's user-chosen host label, shown in place of the hostname when set (ssh commands always use the real hostname); the origin/port never appears in the UI
Agents     GET  /api/agents                  # registered adapters: id, display name, capabilities the UI gates on,
                                             # plus `binary` and `available` (is that executable on the daemon's PATH)
Accounts   GET  /api/accounts?profile=…      POST /api/accounts {profile_id, agent_type, label, skip_permissions_default?, import_dir?}   # import_dir: copy a pre-existing config dir (§2)
           PATCH /api/accounts/:id {label?, skip_permissions_default?}   # rename (label only; config dir stays put) + §11 gate opt-in
           DELETE /api/accounts/:id                  # 409 while any of its sessions is non-archived; removes the config dir (logs the account out)
           POST /api/accounts/:id/login      # spawns interactive login PTY; UI attaches like a session; response may carry an adapter `hint` (13.1) the dialogue shows
           GET  /api/accounts/:id/usage      # session counts + last activity (puddle); best-effort agent token totals; live_usage (context fill %, cost) via the status line; subscription rate-limit windows via the agent's own CLI (logged-in accounts, daemon-cached) — all nullable
Repos      GET  /api/fs/dirs?prefix=…        # directory autocomplete for repo registration (dirs only, dotdirs included, is_git flag)
           GET  /api/repos                   POST /api/repos {path, default_base_branch?, onboarding_notes?, fetch_enabled?}   # omitted/empty base follows the clone's current branch on every new session (detached → main)
           PATCH /api/repos/:id               # same fields (onboarding_notes also updatable via the .puddle marker-file sync — §4)
           POST  /api/repos/:id/fetch         # manual fetch now; path must be an existing git repo (validated on POST; ~ expands on the host; re-registering a known path returns it)
           GET   /api/repos/:id/branches      # local + fetched remote heads, deduped, default base first; entries are {name, is_session, session_title} so pickers can label puddle-owned branches
           GET   /api/repos/:id/worktrees     # {worktrees:[{path,branch,is_primary,dirty,local_only}], orphan_branches:[{name,local_only}]}; feeds the join picker (§4) and worktree manager (§8)
           DELETE /api/repos/:id/worktrees?path=            # prune a worktree dir (branch kept); refuses clone/dirty/live-session (§8)
           DELETE /api/repos/:id/branches?name=&confirm=    # delete an orphaned branch (no worktree); refuses branch_in_use; confirm required when local-only (§8)
Projects   GET  /api/projects?profile=…      POST /api/projects {profile_id, repo_id, name}   # ids are 10-hex handles (/project/:id)
           PATCH /api/projects/:id {name?, archived?}   # rename (UNIQUE(profile,name) → 409) and/or archive (reversible hide, §11)
           GET  /api/projects/:id            # detail incl. sessions with status
           POST /api/projects/:id/archive
           POST /api/projects/:id/conversations/refresh # 204 immediately; coalesced activation-driven native scan
Sessions   GET  /api/sessions?project=…&status=…
           POST /api/sessions {project_id, account_id?, kind?, base_branch?, branch?, separate_branch?, cwd?, title?, prompt?, skip_permissions?}
                # kind defaults 'agent' (needs account_id); kind:'terminal' spawns a plain shell with
                # no account/agent and defaults separate_branch to false (§4 Terminal sessions)
                # agents whose CLIs mint conversation ids return immediately with agent_session_ref:null;
                # the daemon captures and persists the native ref asynchronously (§5)
                # cwd: TERMINAL only (400 cwd_terminal_only otherwise) — a worktree-relative directory
                # the shell starts in, confined to the worktree and persisted, so a resume
                # returns to it (400 cwd_not_a_directory if it is not one) (§4, §8)
                # separate_branch defaults true for agents; false = work directly on the base branch in a
                # shared worktree (§4 Relaxed isolation) — branch must then be absent (400 branch_with_shared)
                # branch naming: requested branch → prefix + title slug → prefix + first words of the
                # prompt → prefix + a memorable adjective-noun-element triple (quiet-tarn-fire) — never a uuid fragment
                # skip_permissions is honoured only if the profile gate AND the account opt-in allow it;
                # otherwise the request is rejected (400) — enforced server-side, no CLI/API bypass
           GET  /api/sessions/:id            # detail incl. git summary and optional conversation_id,
                # parent_conversation_id, conversation_missing, branch_owner, native_sync;
                # agent_session_ref/agent_title remain public join fields, not placement columns
           PATCH /api/sessions/:id {title?}   # rename (does not rename the git branch)
           POST /api/sessions/:id/resume | /kill                # lifecycle
           POST /api/sessions/:id/archive | /unarchive          # reversible hide, no body (§4): archive kills a live
                # session first, keeps the worktree/branch/conversation, and is idempotent on an archived one;
                # unarchive → exited (resume disabled if worktree gone)
           POST /api/sessions/:id/migrate {account_id}    # tier-1: same agent, resume on another account (§5) — IMPLEMENTED
                # validations in order: target exists (404) → same profile (400 cross_profile_account) →
                # same agent_type (400 agent_mismatch) → not the current account (400 same_account) →
                # not archived (409 session_archived) → target logged in (409 account_logged_out) →
                # conversation reachable (409 migration_unsupported when neither the shared store nor a
                # migrateSession hook can carry it). A live session is killed first; skip_permissions is
                # re-evaluated for the target (§11.4). Returns the resumed session detail.
           POST /api/sessions/:id/handoff {account_id}    # tier-2 cross-agent hand-off; returns the NEW session
                # handoff order: same profile (400 cross_profile_account) → a DIFFERENT agent (400 same_agent —
                # same-agent targets belong on /migrate) → not a terminal session (400 not_migratable) →
                # not archived (409 session_archived) → worktree present (409 worktree_missing) → target agent
                # installed (424 agent_not_installed) and logged in (409 account_logged_out). The new session
                # joins the source's worktree and branch; the SOURCE IS LEFT RUNNING and untouched, and the two
                # are linked by `handed_off_to` / `handed_off_from` events.
           GET  /api/sessions/:id/env        # captured env (§4): names + byte sizes + optional values (16.2)
           DELETE /api/sessions/:id/env      # drop every captured var (new spawns stop receiving them); returns {cleared}
Scratchpad GET  /api/scratchpad?profile=…&project=…   # profile-scoped + the project's own, ordered
           POST /api/scratchpad {profile_id, scope, project_id?, body, title?, tags?, agent_type?}
           PATCH/DELETE /api/scratchpad/:id   # PATCH position = drag-reorder (fractional midpoint)
Layouts    GET  /api/layouts?profile=…&project=…   # saved layouts (12.2): profile-scoped + the project's
           #                                         own, by name; without `project`, ALL of the profile's
           POST /api/layouts {profile_id, scope, project_id?, name, layout_tree, active_session?}
           PATCH/DELETE /api/layouts/:id      # PATCH name = rename; layout_tree (+active_session) = save over
Compile   GET  /api/compilation/capabilities # daemon-host provider availability, source/input extensions, executor, eager support (17.1)
           POST /api/compilation/run           # {source:{session,path,root?},provider?} → provider/executor/revision/resolved source/artefacts/terminal?
           PUT  /api/compilation/mode          # the same target + on_demand|eager; eager registers observation and performs an initial build
           POST /api/compilation/status        # pollable per-target mode/run/result/error state for eager builds
           POST/PUT /api/compilation/settings  # per-file command lookup/override; inherits profile language defaults (17.3, 24.4)
           POST/PUT /api/compilation/defaults  # {profile_id,provider} lookup; PUT adds mode,command (null resets) (24.4)
Notebooks GET  /api/notebooks/kernels         # installed host kernels, cached bounded discovery (24.6)
           POST /api/notebooks/status          # {source} → stopped/starting/idle/busy/dead + selected kernel
           POST /api/notebooks/kernel          # {source,action:select|interrupt|restart|shutdown|select-python|install-python,kernel?,python?}
           POST /api/notebooks/environments    # {source} → bounded Python discovery, including missing packages (25.1)
LaTeX     POST /api/latex/synctex              # managed PDF target + page/x/y → confined rooted source + line/column (17.1, §8)
Files      GET  /api/worktrees/:sid/tree?path=…      # + optional absolute `root=` (10.2): browse override for parent-directory
           GET  /api/worktrees/:sid/file?path=…      #   navigation (§8) — on GET tree/file/media/download, the file PUT (10.4,
           #                                             so external tabs save to the file they read), since 12.3 the fs
           #                                             mutations + upload (making the browse tree the worktree tree), and
           #                                             since 12.4 the git family below. Every path stays
           #                                             `containedPath`-confined under the OVERRIDDEN root, and each
           #                                             mutation's returned `path` is relative to it. Body paths stay relative:
           #                                             an absolute one is still a 400 `path_outside_worktree`.
           # `:sid` = the NIL uuid (12.4): a DIRECTORY target — no session, work against `root=` (400 `root_required`
           #                                             without it). What binds the left sidebar to a project's own repository
           #                                             directory when no session qualifies (§8); a `base` diff then compares
           #                                             against the default branch of the repo registered at that path, else
           #                                             `HEAD`. The nil uuid is already a valid `sessionId` (10.3), so nothing
           #                                             persisted had to change.
           #                                         # file GET: 5 MiB read cap (413 `file_too_large`)
                PUT (write; body = full content; optimistic `expected_mtime_ms` — mismatch or a file that
                # no longer exists → 409 `stale_file`; omit it to overwrite unconditionally)
           GET  /api/worktrees/:sid/resolve?path=…&line=…&root=… # validates terminal/palette path targets; root supports a directory target
           POST /api/worktrees/:sid/paste {mime, data}      # base64 clipboard image → .puddle/pastes/; returns {path} relative to the worktree (§7)
           POST /api/worktrees/:sid/upload?dir=…            # multipart file upload into a worktree directory, path-contained (drag-in transfer — §8);
                # a multipart filename may carry a dir-relative path (folder drops) — intermediate directories are created, `..`/`.` segments dropped, never resolved;
                # 512 MiB actual-byte per-request cap (413 `upload_too_large`), enforced while streaming into private disk staging; up to 10,000 files / 8 MiB of relative filenames per request — the web batches big drops into ~64 MiB requests; a same-name file already there is overwritten silently
           GET  /api/worktrees/:sid/download?path=…         # file → bytes; directory → zip stream excluding `.git` and symlinks (Content-Disposition attachment) (§8)
                # asynchronous traversal, one active file plus one successor; ZIP metadata capped at 10,000 files / 8 MiB of paths / depth 128; exceeding a bound fails the stream rather than returning a truncated archive
                # uploads and directory downloads share four active transfer slots (503 `transfer_busy`); cancellation closes source streams and enumeration handles
                # uploads validate the complete multipart body before destination writes, preserve symlink/hard-link/mode overwrite semantics, and remove private staging on success/failure/cancellation; cancellation during commit finishes the current file and stops between files (a batch is not a filesystem transaction)
           GET  /api/worktrees/:sid/media?path=…            # file → raw bytes with its real content-type (image/*, video/*, audio/*, application/pdf) + inline disposition, for the media viewer; octet-stream fallback for unknown types (§8)
           GET  /api/worktrees/:sid/preview-asset?path=…    # 21.1: optional validated root; up to 8 MiB as {mime,data} (base64), bounded JSON for encrypted remote previews; 413 preview_too_large above the cap
           POST /api/worktrees/:sid/create {path, kind:file|dir}   # empty file / mkdir -p; 409 `already_exists`; path-contained (§8)
           POST /api/worktrees/:sid/rename {from, to}       # one fs.rename — rename or move; 404 missing, 409 `already_exists` (§8)
           POST /api/worktrees/:sid/copy   {from, to}       # recursive copy; `to` auto-suffixed ` copy` on collision; returns the final {path} (§8)
           POST /api/worktrees/:sid/transfer?root=…          # 16.3: {operation:copy|move, source:{session_id,root?}, from, to};
                # server-local cross-filetree transfer into the URL/root-addressed destination; copy suffixes collisions,
                # move rejects them and falls back to copy-then-delete only when rename crosses filesystems (§8)
           POST /api/worktrees/:sid/delete {path}           # recursive remove — no host trash (§8)
Git        # every route below takes the same optional absolute `root=` since 12.4 (ignored before it), so the
           # Changes, History, and Search navigators can report a DIRECTORY target's git state (the nil `:sid` above)
Git        GET  /api/worktrees/:sid/git-status                # whole-worktree porcelain map [{path, status}] for tree decorations; status ∈ untracked|modified|added|deleted|renamed|conflicted|ignored (§8)
           GET  /api/worktrees/:sid/git-repositories          # 15.3: owning + ignored nested repositories + recursive submodules;
                # porcelain-v2 branch/upstream/ahead/behind metadata and staged/unstaged/conflict groups; explorer entries rebased to visible root
           GET  /api/worktrees/:sid/diff?against=base|head|<sha>&area=staged|unstaged   # name-status list; `against=base` resolves to the
                # merge-base of the base branch (`origin/<base>` when it exists, else local) and HEAD;
                # `against=head` without area is working tree vs. HEAD; staged is HEAD→index, unstaged is index→working tree
           GET  /api/worktrees/:sid/file-at?ref=…&path=…      # blob content for DiffEditor 'original'
           GET  /api/worktrees/:sid/index-file?path=…         # deepest owning repository's index blob (staged/unstaged diff side)
           GET  /api/worktrees/:sid/git-original?path=…       # deepest owning repository's HEAD baseline for ordinary-editor gutter indicators;
                # explicitly reports outside/ignored/untracked/unborn/binary cases and follows staged renames back to the HEAD path
           POST /api/worktrees/:sid/git-stage|git-unstage     # {repository, paths}; literal repository-relative confined pathspecs
           POST /api/worktrees/:sid/git-commit                # {repository, message, stage_all?}; staged content only unless stage_all was confirmed
           POST /api/worktrees/:sid/git-fetch|git-pull        # {repository}; pull is fast-forward-only
           POST /api/worktrees/:sid/git-push                  # {repository, set_upstream?}; set_upstream publishes the current named branch
           GET  /api/worktrees/:sid/log?limit=…&skip=…        # history; each commit carries its `parents` (graph lanes)
           GET  /api/worktrees/:sid/show/:sha                 # commit detail + changed files
           GET  /api/worktrees/:sid/search?q=…&regex=&case=&word=   # filename + content search (git grep; regex=PCRE)
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
  {t:'spawn-shell', session}                   # bash PTY cd'd into the worktree; reply carries the new shell id.
                                               # On the project-less `home` stream: a shell at ~ on the daemon host
                                               # (§11); while one is live the reply is ITS id — never a second shell
  {t:'kill-shell', session, term}              # terminate a shell PTY (never the agent term); viewers learn via `exit`
  {t:'subscribe-status'}                       # sidebar live updates

server → client:
  {t:'shell-spawned', session, term}           # id for a spawn-shell request
  {t:'replay',  session, term, data}           # self-contained ANSI screen + scrollback snapshot on attach
  {t:'output',  session, term, data}
  {t:'status',  session, status, last_activity_at}
  {t:'renamed', session, title}                # title changed (UI rename or agent self-naming)
  {t:'session-switched', source_session, target_session, target_project, cause, outcome}
                                               # exact native clear/resume/fork rebound, or focus an existing runtime
  {t:'sessions-changed', project_ids}          # catalogue-created/recovered/missing/renamed placements; invalidate lists
  {t:'exit',    session, term, code}
  {t:'error',   message}
```

**Synchronised terminal redraws**: the browser's pinned xterm 6.0.0 receives a narrow compatibility fix for standalone `CSI ? 2026 l`: ending synchronised output requests the cursor row instead of the whole viewport. Its existing renderer merges pending dirty ranges across writes, retains cursor and full-screen invalidations, and keeps the native missing-end timeout. Compound mode resets retain xterm's normal handling. PTY bytes, parsing and screen state remain unchanged.

**Multi-viewer semantics**: any number of viewers (browser windows/tabs, `puddle attach`) may attach to the same session concurrently; `output`, `status`, `renamed`, and `exit` are broadcast to all attached viewers, and `stdin` is accepted from any of them (last-writer-wins, like tmux). **Attach restores canonical terminal state** (2026-08-14): the daemon parses every filtered PTY byte through a headless xterm and atomically persists its screen, cursor, terminal modes, and 20,000-line scrollback beside the diagnostic raw log. An arbitrary raw-log tail is not a screen snapshot — it can begin halfway through a cursor-addressed TUI redraw, so resetting a cached browser terminal and writing that tail produced the blank screen and displaced fragments seen after leaving and returning. The `replay` message now carries the headless terminal's self-contained ANSI serialisation, reflowed to the attaching viewer; legacy terminals without a snapshot import their log tail once. Output arriving while a snapshot is made is held for that viewer and delivered after replay, establishing an exact boundary with neither gaps nor duplicates. The persisted state is released from daemon memory when its PTY exits and loaded on demand after a daemon restart. This lives in the agent-agnostic PTY layer and therefore covers every coding agent, login terminal, and shell. **Each web terminal keeps its viewport position** (2026-08-21): leaving a session, detaching its hidden viewer, and replaying the canonical snapshot on return no longer forces a deliberately scrolled-up terminal to the bottom. Browser-window state keyed by PTY identity restores the same retained buffer line after replay and across workspace remounts; a terminal that was already at the bottom continues following newly appended output. Refit/resize preserves the same distinction. Initial fitting and scroll events from an empty newly mounted xterm cannot overwrite saved state before the first snapshot has finished replaying. **Top-anchored TUI scrolling retains transcript rows** (2026-08-24): xterm 6.0.0 implements `CSI S` by deleting rows when a scroll region starts at row 1, unlike the equivalent line-feed path; agent TUIs use that command while streaming beside a fixed input panel, so lines intermittently vanished from scrollback. Puddle applies the narrowly scoped upstream fix to both the live browser emulator and the daemon's exact-pinned headless emulator, keeping live output and later attach snapshots identical; regions with a non-zero top margin keep native xterm semantics. **Live output is frame-batched** (2026-08-14): the gateway coalesces the tiny chunks from a chatty TUI into at most one message per ~16 ms (or 64 KiB), and the web viewer independently coalesces messages to its next animation frame for compatibility with older daemons. Bytes and order are unchanged, output is flushed before exit/detach/replay boundaries, and the cap bounds pending memory. This prevents a 100-redraw/s Codex session from growing xterm's write queue faster than the browser can paint, which delayed echoed input and could leave a synchronised redraw blank mid-frame. **Device queries get exactly one answer** (2026-08-10): every viewer is a full terminal emulator (web xterm, or the user's own terminal under `puddle attach`) and each auto-answers a program's `ESC[6n` cursor-position / `ESC[c` device-attribute / DECRQSS queries independently — the program reads one reply and the rest landed in the shell's input line as junk keystrokes. The gateway keeps one **answering viewer** per (stream, term) — the most recent attacher/resizer, i.e. the viewer whose grid won the PTY size, so its cursor reports are the authoritative ones — and strips reply-shaped sequences from every other viewer's stdin (`ws/device-replies.ts`; typing never matches the reply shapes, with modified F3 as the one documented exception, deliberately let through). With a single viewer nothing is ever stripped, and the role falls to the most recent remaining viewer on detach. A PTY has exactly one size: the most recent `attach`/`resize` wins, and the daemon delivers the resize (SIGWINCH) so full-screen agent TUIs redraw at the new size — smaller concurrent viewers scroll rather than reflow. **The focused viewer re-claims the size** (2026-08-10, tmux's `window-size latest`): clicking into a terminal refits and re-sends that viewer's dims, so the geometry follows the window actually in use — before this, a second window's re-attach shrank the PTY under the first, which then faithfully rendered the TUI's small-screen redraw as a blank bottom/right until a page reload re-asserted its dims (a same-size re-assert is a no-op end to end: no SIGWINCH). **The web viewer uses xterm's built-in renderer** (2026-08-14): the optional WebGL addon was removed after context loss and silent backing-store eviction repeatedly blanked working terminals and recreating the same renderer on reload reproduced the failure. A foregrounded viewer still refreshes every row after one animation frame; this recovery does not resize or clear the renderer, so it introduces no blank intermediate frame. Genuine geometry changes remain ResizeObserver's responsibility. **That size outlives the PTY** (decision 2026-08-04): the daemon remembers the last size asked for per (stream, term) — whether or not anything was live to receive it — and starts the NEXT PTY on that stream at it, falling back to 120×32 when no viewer ever sized it. A resume or an account migration replaces the process under an already-attached viewer, and nothing re-sends the size then (no fresh `attach`, no container change), so a fixed default left the new agent drawing to a screen that was not there. The web side closes the same gap from its end: a terminal refits, repaints, and re-sends its size whenever its cell size changes (the terminal font-size setting resizes the CELL, not the container, so no ResizeObserver fires) or whenever the status feed reports its session going from a dead status back to a live one — which only a fresh process can do. Snapshot replay ends with a full viewport refresh and is **render-only from the viewer's side**: recorded terminal state may contain the query sequences programs once emitted, and re-parsing them must not re-answer them — the viewer's own OSC side effects (colour queries, clipboard writes) and xterm core's CSI auto-replies (`ESC[6n` cursor-position reports, device attributes), which surface through the same `onData` event as typing, are all suppressed while a replay parses. Un-suppressed, every re-attach typed the stale answers (`^[[37;143R…`) into the shell's input line as junk keystrokes (fixed 2026-08-10). The browser's terminal scrollback defaults to 20,000 lines (2026-08-14, migrating the exact old 5,000-line default): wrapped carriage-return progress such as `tqdm` can otherwise consume 5,000 rows and evict everything above it during one training run. **The URL binds to one project, the workspace to the profile**: routes are `/` (project dashboard), `/project/:id` (the workspace — navigator, terminals, editor), and within it `/project/:id/session/:sid` (the active session). Diff and History are left-navigator modes (§8), not routes. The centre tiling area is ONE surface per profile (§11 reload semantics): navigating between projects keeps the same workspace, with only the URL-bound session (and the left sidebar's binding) changing. Everything is deep-linkable, so reloading a window (or opening it on another laptop) lands back in the same state.

**Parked viewer retention** (2026-11-05): each browser window keeps the three most recently parked terminal viewers warm. Other offscreen viewers become eligible after one minute detached; captures run serially, at least one second apart. Never-visited parked tabs do not allocate an xterm. A successful capture retains the full local transcript as UTF-8 bytes in component memory, then disposes xterm, addons, handlers and observers while preserving the stable portal container. Returning restores the original grid and viewport before fitting the current pane, then waits for the existing canonical replay before accepting input. Disconnected and confirmed-exited local transcripts remain readable and copyable. Captures never enter persistent browser storage or the network. Selection, open find controls, alternate buffers, OSC 8 links, unfinished synchronised output, capture failure and snapshots over 8 MiB keep their live viewer; the three-view limit is therefore a soft budget, never permission to truncate history. User-selected scrollback, dirty editor buffers and visible offline mobile terminals are unaffected. Closing the last tab releases either representation. The pinned serialiser’s omissions are guarded and covered by real-browser replay tests; re-evaluate those guards when upgrading xterm.

Resize preservation is logical-line-aware, not a raw scrollback-row replay: xterm can insert or remove any number of wrapped rows above the viewport when its column count changes, so the viewer anchors the logical line currently at the top and resolves that anchor after reflow. The anchor remains alive briefly after the PTY resize because an application may react to `SIGWINCH` asynchronously. If it purges and rebuilds the entire scrollback (for example, an inline TUI re-emitting its transcript at the new width), xterm necessarily disposes the exact marker; the viewer then restores the same proportional transcript progress after each parsed rebuild chunk until output settles. User scrolling supersedes the guard immediately, bottom-following viewers remain bottom-following, and alternate-screen activity never overwrites the normal transcript's saved position. The same shared fit path covers pane/window resizing, focus size reclamation, font changes, and keep-alive reattachment for every agent terminal, login terminal, and shell; zero-sized parked containers retain their last geometry and viewport.

**Mouse encoding survives replay** (2026-09-25): attach and disk snapshots preserve the emulator's selected SGR cell or pixel encoding independently of mouse tracking, including when tracking is temporarily disabled. The pinned xterm serialiser saves tracking but omits encoding, so the daemon appends the encoding from its canonical emulator through one shared serialisation path. Without it, replay silently changes SGR wheel and drag reports into legacy binary input, which the web viewer does not forward. This restores fullscreen Codex scrolling and selection without changing agent launch flags or mouse ownership. Encoding changes and terminal resets follow xterm's own state; legacy snapshots cannot recover encoding that was never saved, and require the application to enable it again (normally on resume).

Independent runtimes publish the existing session `status` feed after committing
observations and confirming the owner's placement binding and acknowledgement.
Unchanged observations do not repeat the status event. A live status after exit,
interruption, or attachment to recorded history makes the browser reattach the
main terminal to its current owner/generation on the existing socket, then await
canonical replay before forwarding input or deferred geometry. Input is never
queued across replacement. Auxiliary shells are not recreated by session restart
and are not reattached by that status transition. A fully restored viewer with a
confirmed terminal exit retains its transcript when its owner disconnects; it
does not close the shared browser socket. Queued/in-flight resize failures after
that confirmed exit are harmless, while uncertain input, unexpected live-owner
loss and incomplete snapshots still require recovery. These rules are shared by
all agent adapters and plain terminal sessions.

### Connection authority (protocol 18.0)

Shared schemas in `api/connection-auth.ts` define host control (`open`, explicit-resource `renew`, `close`), delegated authority/inspection replies, browser bootstrap, proxy grants/exchange, launcher invitations, cockpit status and authentication errors. `api/cockpit.ts` defines refresh correlation. Browser APIs include `POST /cockpit/remote/registration` (protocol 20.0, authenticated read-only service polling), `POST /cockpit/bootstrap`, `POST /cockpit/logout`, `GET /cockpit/status`, `POST /cockpit/proxy-grant`, `POST /cockpit/refresh` and `GET/PUT /cockpit/local-sync`. Proxy invitation exchange is `POST /proxy/:sid/:port/_puddle/exchange` on the isolated application origin. Error codes distinguish `browser_rejected`, `upstream_expired`, `upstream_unavailable` and `protocol_mismatch`.

The daemon WebSocket first receives `{t:'auth', token, resource}` and acknowledges `{t:'authenticated'}`. Browser WebSockets send their cockpit credential without a resource id; the bridge supplies a fresh resource and current connection token upstream. HTTP uses the connection bearer and `X-Puddle-Resource` for renewable streams. Neither browser credentials nor data tokens admit host-control requests.

### Self-hosted remote surface (remote protocol 5)

Application protocol 26.0 and remote protocol 5 add separately host-approved device
maintenance. Update the service, application and host connector together. Existing
registrations and pairing approvals remain; none gains maintenance automatically.
Historically, application 24.0 renamed `Session.agent_mode` from `scripted` to
`headless`, accompanied by remote protocol 4.

The remote dashboard and Settings expose **Pair this device**. Its camera scanner
decodes QR frames locally with the bundled JavaScript decoder (including browsers
without BarcodeDetector), or accepts a pasted pairing link. Links must target this
application's `/remote/pair` route and carry a schema-valid invitation for this
service that has not expired. Scanning never navigates to the link or creates a
device key: the existing name/host-identity confirmation and exact host approval
follow, using the current app context's IndexedDB identity. Home Screen apps and
Safari tabs can therefore pair separately. Invitations remain tab-scoped until
used or dismissed, and expiry is checked again on confirmation. Camera access
starts only on an explicit scan action, requests no audio, bounds frames to 960
pixels on their longest side and decodes at most five frames per second. Camera
startup times out after twenty seconds; cancellation, success, failure, page hiding
and late permission replies release the tracks. The application response allows
only its own camera access; sandboxed file previews deny it. Web Settings no longer
creates host registration codes; desktop Settings → Remote & Sync remains the
registration entry point. The existing service/CLI registration API is unchanged.

The service owns `/api/auth/*` through Better Auth, `GET /remote/config`, `GET /remote/me`, `GET|POST /remote/hosts`, `DELETE /remote/hosts/:id`, authenticated `POST /remote/desktop-registration`, and machine-only `POST /remote/register`, `POST /remote/registration-status` and `POST /remote/unregister`. WSS `/remote/browser` requires a verified service session (plus optional MFA) and exact application Origin; `/remote/connector` and `/remote/pipe` require the host's routing credential and reject browser origins. The service never accepts a daemon token. Browser and connector use Noise XX with pinned host identity and a prologue binding service, host, protocol and connection id. Service login is insufficient to acquire host authority.

Desktop registration adds a five-minute browser approval of a public SHA-256 challenge. The initiating cockpit holds the random 256-bit verifier in memory; only the challenge, host label, application/service origins and expiry enter the application URL fragment. The application strips the fragment before OAuth and retains only this public request in tab-scoped session storage. A verified account with any required MFA explicitly confirms the matching request identifier. The service validates its own application/service origins, bounds expiry and host/account registration quotas, and stores only the hash. Machine-only status polling proves knowledge of the verifier without consuming it or revealing account credentials; the connector redeems it once through the existing machine-only exchange. Used challenges remain until expiry to reject duplicate approvals, including after host deletion. Expired abandoned hosts are pruned. Service state version 2 adds this bounded handoff table without modifying existing registrations. Host identity keys are generated on the host and browser grants still require separate approval.

Shared schemas in `shared/src/remote/` own framing, pairing, device administration and service responses. The connector's explicit route table (`connector/src/policy.ts`) permits configured project/session discovery and lifecycle, placement terminals/shells, and read-only file/Git inspection; all other operations are denied. It constructs only fixed loopback daemon requests. Browser-supplied credentials, headers, arbitrary upstreams, account login/home streams, general transfers, Git mutations and `/proxy` are excluded. Read-only previews use the bounded `preview-asset` JSON route; raw `media`/`download` routes remain denied. Repository scripts execute only in a sandboxed document without application authority. An approved terminal still has owner-level execution authority.

Protocol 21.2 adds connector-local `POST /api/worktrees/:sid/paste-upload` with strict `start`, `chunk`, `finish` and `cancel` bodies. The connector alone advertises `remote_image_uploads` in the encrypted `/api/version` response; browsers must check it before using the new route. One image per browser connection is staged in memory, capped at 4 MiB, with sequential 64 KiB base64 chunks, exact offsets and acknowledgements. Ordinary requests retain the 256 KiB cap. Uploads expire after 60 seconds idle or five minutes total, and are discarded on cancellation, disconnect or revocation; identifiers cannot be reused. Only a complete upload becomes the existing host-local `/paste` request, with host-owned credentials and a fresh lease check. No destination/root override, partial file or automatic replay is allowed. Cancellation during the final save can leave a completed file, but the browser must not insert its path after cancellation or a connection change. All chunks, preview assets and file metadata use the existing end-to-end encrypted Noise channel. The relay sees routing and traffic sizes/timing, never those payloads.

Protocol 22.4 adds opt-in background notifications without changing remote envelopes or host authority (remote protocol remains 3). `GET /remote/config` optionally advertises `push_public_key`; the connector adds `remote_notifications` to `/api/version` only with a daemon that emits private push signals. Strict connector-local `POST /api/notifications/push` registers or removes a subscription for the exact admitted Noise device; `/api/notifications/test` sends a generic test to that device. Both use the existing participating lease and are denied as daemon operations. Protocol 22.5 adds optional bounded content (conversation title, last-output snippet and project/session ids) to the private `{t:'notify',id}` signal after checking the owning profile’s desktop-notification preference and project mute. Before private dispatch, the daemon prefixes the push title with the project abbreviation (`[ABBRV] Session title`), using the same saved abbreviation or derived fallback as the project rail and live browser alerts, and bounds the complete title to 160 characters. Live events keep the plain session title for native desktop subtitles. An older connector’s explicit rejection retries the legacy id-only signal; uncertain sends are not replayed. It neither opens a daemon stream nor renews browser authority after disconnection. The connector checks enablement and the device’s existing approval/expiry before each send. Revocation and disablement stop new dispatches; push already accepted by a vendor can still arrive within its two-minute TTL.

Machine-only `POST /remote/push/register` and `/remote/push/notify` use the existing routing credential, reject Origin/cookies, and cannot select another host. The service persists private VAPID keys and bounded vendor subscription metadata; it sends an opaque event id, the already-known host identifier and an optional encrypted preview. The browser capability-detects connector `remote_notification_previews` (daemon 22.5) and service `push_encrypted_previews` before exchanging a random per-host/device AES-256-GCM key over the admitted Noise connection. The connector stores this key only in its private device database (version 3); the service registration schema rejects it. Each preview uses a fresh 96-bit nonce and authenticates the host, event and key identifiers as additional data. Only the notification worker decrypts it. The service never receives plaintext titles, snippets, project/session ids or preview keys and never persists previews. Legacy subscriptions retain generic alerts until an opted-in browser reconnects. Removing a pairing or disabling notifications removes browser keys; revocation removes the connector key. Vendor endpoints are restricted to supported HTTPS push providers, requests are bounded and timed out, subscription expiry is capped at 90 days, and 404/410 responses remove dead subscriptions. The service still observes notification timing and device/vendor routing metadata. Tests report vendor acceptance, not proven OS banner visibility. Remote Settings keeps enablement and test results directly below the notification controls, with a Sending… label and progress through host support, subscription lookup, host registration and sending during an explicit test. Tests require a granted permission and a live subscription, reconfirm host registration rather than trusting the local cache, and stop if the connection generation changes. Browser worker-registration and subscription reads have ten-second deadlines; late replies cannot continue a failed test. Successful worker registration is reused within the page, while failures clear it for retry. The settings dialogue uses a shrinkable single-column grid and wraps long account/host labels and account-security controls at phone widths.

The remote settings device opt-in requests permission from a user gesture, subscribes its notification-only service worker, and synchronises each connected paired host independently. Disable/sign-out unsubscribes this browser; host/profile notification toggles and project mutes also apply. The app manifest enables Home Screen installation on iOS/iPadOS. Opted-in push displays while open or closed, independently of the cockpit’s focused-delivery setting. Every received push calls `showNotification` to fulfil Safari’s visible-only requirement. Confirmed push bindings suppress duplicate live alerts; matching event tags replace a racing live alert without renotification. A bounded IndexedDB store retains only recent opaque event ids to suppress late live duplicates. Notification clicks focus the app and select the exact project/session, including when a different conversation or host is already open. Cold clicks carry only validated host/project/session identifiers in the app URL; the destination survives login/MFA and requires ordinary pairing/host authority. Missing or archived sessions show an unavailable message rather than selecting an unrelated conversation. A missing key or invalid ciphertext still shows a generic visible alert. Browser IndexedDB stores preview keys and bounded opaque receipts, never decrypted host content. The worker never intercepts fetches or caches host content.

Protocol 21.0 adds host-authenticated registration retirement. `POST /remote/unregister` accepts only the existing routing credential in a strict body, rejects Origin/cookies, and removes exactly the record authenticated by that credential, closing its relay connections. An unknown/already-retired credential is an idempotent 204 with no account or host-id oracle. It cannot select another host, grant browser authority or merge same-named machines.

Each host/profile keeps independent private `remote/profiles/<profile_id>/config.json` (routing credential), `identity.json` (Noise identity), and `devices.db` (SQLite version 2, invitations, grants and opted-in notification devices). One registration per profile may bind to its own remote account and service; multiple profiles connect concurrently through the same daemon. A single supervised connector watches these stores and replaces only the changed profile’s runtime. Profile-specific mutation sockets serialise CLI/cockpit writers across processes; device approvals, disablement, reset and deletion affect only that registration. Startup deletes the legacy `remote/config.json`, revokes its grants and queues its relay retirement through the existing cleanup mechanism; old registrations never inherit a profile. The root connector socket excludes a live legacy writer before migration. The service keeps private `remote.db` (routing/registration/MFA confirmation and push-subscription tables (schema version 3), alongside Better Auth's maintained account schema). Invitation/code verifiers are hashed. Invitations expire in five minutes, are reserved atomically for one exact enrolling browser, and require explicit local/SSH or already-paired approval. Browser identities live in IndexedDB scoped to service/account/host. Grants expire at 30 days idle/90 days absolute. Revocation is durable and checked before dispatch. Offline local disable is observed within 500 ms; it never stops an agent.

Protocol 22.0 binds each remote host-control lease to the registering profile, selected on the host before any browser data request. The daemon filters profile/account/project/session/repository discovery, checks direct resource ids and session creation, and filters WS output, status, notices, account updates and catalogue/placement-switch events. Repository branch annotations and worktree choices expose only this profile’s Puddle sessions. Remote protocol 3 records this change in access semantics. Unknown scoped operations fail closed; both the connector allowlist and daemon profile policy require review for additions. Unscoped local/SSH leases retain their existing access. Profile scope is Puddle organisation, not an OS sandbox: placement terminals and explicit directory browsing still have the shared OS user’s filesystem authority.

Each admitted browser gets its own manual-participation host control generation. An encrypted challenge issued every 15 seconds must return once within 15 seconds with explicit resource ids; renewals anchor to issue time and expire after 45 seconds. Existing 30-second rotation and 60-second token expiry remain. Reconnect restores snapshots without retrying input/mutations. Limits, cancellation and request ids live in `REMOTE_POLICY`; overload detaches rather than accumulates. The relay stores account/routing state and bounded transient ciphertext, with no content/access logging. HTTPS app and relay origins must differ under one site; production headers include CSP, framing denial, no-store and nosniff. The static app's distributor is trusted with plaintext and keys, even when transport encryption is enabled.

The offline `puddle --version` inventory appends the bundled connector protocol to the daemon’s protocol, for example `22.0c3`. Release archives carry a separate `CONNECTOR_PROTOCOL` integer alongside the unchanged plain `PROTOCOL` major/minor file. Known historical releases use the offline lookup; unknown connector versions omit the suffix. This display has no role in CLI/desktop compatibility decisions.

### Protocol versioning and compatibility

The CLI (and the UI it serves) and the daemon ship separately from Phase 6, so the communication layer — every REST shape and WS message above — is a versioned contract. Component releases and wire protocols must not be conflated:

- **App version**: each component's npm/tarball semver. `puddled --version` reports that daemon itself; `puddle --version` is the local, offline component inventory — CLI, daemon, and desktop on separate rows, each with its own app version and speaking protocol (or `not installed`; a legacy Linux AppImage whose stable filename predates self-recording is reported as installed with unknown versions rather than guessed). It reads the daemon's release metadata without executing an unknown historical binary, and the packaged desktop records its actual path/version/protocol in `~/.puddle/desktop-install.json`, so moved AppImages remain discoverable. Released versions predating exact component metadata use the immutable historical ledger in `component-versions.ts`. App version alone says nothing about compatibility.
- **Protocol version**: `PROTOCOL_VERSION = {major, minor}`, exported from `packages/shared` — the protocol package. `packages/shared` already holds every REST and WS schema as executable zod definitions; it _is_ the protocol description, and the single source of truth for it. `packages/shared/PROTOCOL.md` documents the bump rules; there is deliberately no second, prose copy of the schema anywhere — prose copies drift.

**Compatibility rule: same `major` ⇒ compatible, in both directions.** Everything within a major is additive-only:

- _Additive (bump `minor`)_: a new endpoint, a new optional request/response field, a new WS message type, a new enum value peers may ignore.
- _Breaking (bump `major`, reset `minor`)_: removing or renaming an endpoint, field, or WS message; changing a type or the semantics of an existing field; changing auth or the WS handshake.

Two wire rules make the additive path safe: receivers **ignore unknown WS message types** and **tolerate unknown JSON fields** (schemas use loose objects where extension is expected). A newer client on an older daemon feature-detects against the daemon's `minor` and hides what the daemon cannot do; an older client on a newer daemon simply never asks for the new things.

**Protocol 16.0** (2026-08-13) adds `locked` to the closed `editorTabRefSchema.view` enum (§8). This is a major bump even though it adds a value: a 15.x daemon validates `ui_state`, rejects a snapshot containing `locked`, and would make every later workspace save fail instead of safely ignoring the value. The major-version handshake therefore upgrades the daemon before the client can persist the mode. Locked-preview scroll positions are transient browser state; they add no REST field, WebSocket message, or daemon storage.

**Protocol 17.1** (2026-08-28) additively adds daemon-host compilation-provider discovery, generic run/mode/status routes, LaTeX inverse SyncTeX, and optional editor-tab `compile_mode`/`generated_by` fields (§8). A newer client hides compile controls below 17.1; older clients ignore the optional tab fields and never call the new endpoints.

**Protocol 17.2** (2026-08-28) additively lets compilation failures carry bounded compiler output and normalised rooted source diagnostics. A 17.2 web client renders an expandable error notification and Monaco markers; older clients continue to show the failure message and ignore the additional detail.

**Handshake** (shared launcher library, on every CLI/desktop launch, before opening the cockpit):

- `protocol.major` equal → proceed. App-version skew within a major is normal and silent; `puddle upgrade daemon` remains available but is never required.
- Daemon `major` older → **ask before updating the host daemon** through the existing upgrade coordinator, or the canonical bootstrap for legacy hosts (§10). The prompt identifies the host, daemon version and both protocols. Legacy migration warns about its one-time session interruption; modern hosts explain independent-runtime continuity and require a separate exact review for daemon-owned work that must stop. Desktop offers **Update and connect / Cancel**; the CLI asks `y/N`, including default background launches through a private parent/child IPC pipe. Both shells carry the exact interruption approval through the same coordinator. Approval installs the client-pinned daemon release, reacquires compatible host authority and continues connecting. Cancellation, missing approval or a non-interactive terminal never authorises replacement. `--no-upgrade` aborts before asking. Non-interactive operators can explicitly run `puddle upgrade daemon [user@host]` first, subject to any required interruption review.
- Daemon `major` newer (this host was updated by a newer client elsewhere) → refuse with desktop/CLI update guidance; never offer a daemon downgrade.

A stopped modern installation starts its selected service once and waits for trusted host-only inspection before negotiating compatibility. It neither reinstalls nor acquires ordinary API authority to inspect an older major. An explicitly approved older-major update uses a narrowly scoped private connection: exact inspected outgoing version/protocol, one daemon target and the exact verified staged replacement. It cannot supply application credentials, viewer resources, a gateway, profile or remote authority. After apply admission it only observes; unexpected identity closes the connection permanently. This is an update-authority path, not application protocol compatibility.

The host control boundary rejects incompatible authority with a neutral protocol-mismatch error. `ensureDaemon` routes that failure, including modern hosts, through host-only inspection and the single handshake policy in `lib/connection/handshake.ts`. Inspection reads only session status for the interruption count, without requiring the current full session schema. Failed inspection of a known mismatch never falls through to a blind install. After approval, inspection runs again: a host updated by another client is reused when compatible or refused when newer, without overwriting it. The later authenticated HTTP version check and reconnect checks only verify compatibility; they cannot start another update or replace the authority independently of the cockpit.

This is the Docker-daemon model reduced to its useful core: a negotiated, versioned local API — but because the CLI owns daemon installation, we keep exact-major lockstep via confirmed updates instead of maintaining server-side compatibility shims for old clients.

## 7. Terminal UX (links and click-through)

- **Ripple (experimental)**: an optional reading overlay on the existing full-size native agent terminal, disabled by default. Settings → Appearance sets the browser-wide `rippleEnabled` default; a session's shared Renderer menu chooses that default, CLI, or Ripple. Explicit choices and row-boundary preferences are browser/host-scoped placement overrides (each bounded to the latest 256); only the default participates in portable settings sync. Shell, login and dashboard terminals remain native. Enabling, disabling or dragging Ripple never resizes or replaces the underlying xterm instance, PTY attachment, input encoding or clipboard bridge. A small right-edge divider snaps to terminal rows and stores the exposed native row count from the bottom; within three rows of a recognised input area, it stores an offset from that input instead, following draft expansion/contraction and preserving the complete composer. Existing nearby numeric preferences upgrade when the input is recognised; distant boundaries stay fixed. Pane/font resizing clamps the visible boundary without overwriting that preference. Arrow keys adjust the focused divider; double-click or Home restores automatic placement. Automatic placement recognises Codex, Claude Code and Gemini CLI prompt markers near the cursor and OpenCode's input-panel border; normal-buffer CLIs can have their composer high in a short screen. With a recognised composer, the unused blank tail is translated out of view to align native input at the bottom, without changing terminal rows or PTY dimensions; Show CLI restores its original position. Automatic Codex placement includes its live Working indicator and tip, identified independently of animated spinner glyphs. If a manual boundary leaves that status in the reader, it retains one literal block across animation frames rather than switching between Markdown paragraphs and lists. Indentation detection uses the original terminal text and ignores Working spinner frames, so their glyphs and style annotations cannot reformat neighbouring code or prose. A neighbouring blank row and the terminal fit remainder leave breathing room without clipping the first exposed native row; manual row placement still wins. Unknown layouts retain the five-row fallback and manual divider. OpenCode's input border also bounds its conversation columns so its sidebar is not mixed into the reader; its painted canvas supplies reading colours without changing application controls. Show CLI temporarily reveals the native screen for menus and approvals.
  The reader uses the pane's full width, proportional prose, monospace aligned output/code, and browser selection/copy. Surviving Markdown and CLI-hard-wrapped prose reflow; generated style markers preserve parsed ANSI foreground/background colours, bold, italic, underline, strike, dim and inverse styling through the shared Markdown renderer. Concealed cells remain concealed. Recognised Codex, Claude Code and Gemini prompt markers and OpenCode’s coloured user panels become right-aligned user bubbles. Indented continuation lines, Markdown lists, code and intervening blank paragraphs stay inside the same prompt bubble; unindented output starts a new block. A Codex prompt on the actual first viewport row is a pinned one-line summary, with or without an ellipsis: its bubble excludes following indented output and keeps the native jump-to-prompt click. Native prompt colours move to the bubble surface, while terminal padding and Gemini’s half-block backing edges are omitted. These rules are best-effort screen presentation, not a conversation transcript or role protocol.
  Read only the current terminal viewport above the boundary, bounded to 600 rows and 32 Ki characters, with shared rich-output detection limited to 32 blocks and the same conversation-column clipping, excluding sidebars. Gemini's recognised alternate-screen scrollbar gutter is omitted. Box/block drawings retain monospace cells with connected line spacing. Numbered diff rows retain literal line breaks. Reading, code and rich-output overflow remains scrollable without visible scrollbars. Native scrolling refreshes that projection; scrolling past either edge of the proportional content relays the wheel through xterm's negotiated mouse/scroll handling. Printable input and editing keys from an unselected reader focus and reuse the native terminal; selected browser text retains copy behavior. Latest output uses Codex's Escape shortcut only when its native history hint is present, Gemini's Ctrl+End, and OpenCode's Ctrl+Alt+G; these follow the providers' default bindings. Other alternate-screen layouts offer Bottom of view. Editing-key forwarding preserves key codes and modifiers, including Shift+Arrow. Updates are throttled to 32 ms while visible and hold during selection or reading within the current projection; explicit native scrolling follows CLI redraws until the reader itself is scrolled again, without expiring during a delayed remote response. Buffer switches replace the projection rather than accumulate stale frames. Parked/hidden readers and Show CLI suspend ongoing reading-view work.
  Cell styling also retains overlines, all five supported underline variants and underline colours, painted whitespace, bright-on-bold palette selection, and OSC 8 HTTP(S) hyperlink labels/targets. The read-only `ripple/xterm-style.ts` bridge accesses the pinned xterm 6 extended cell attributes and live colour/link services; absent internals fall back to public cell styles. OSC 4/10/11 palette/default changes and 104/110/111 resets refresh existing projected cells. Unsupported xterm effects (such as text blinking) are not invented by Ripple. Browser checks feed actual VT sequences through the mounted terminal to verify this bridge.
  Markdown shares the editor's parser/extensions with raw HTML escaped, images disabled and links restricted to HTTP(S); rendered HTML is sanitised. Ripple strips its private presentation markers before normalising Markdown link destinations. Plain URLs and file paths reuse the native terminal's bounded, wrap-aware buffer detectors; ambiguous file candidates retain their resolve-validated shorter alternatives. The native URL opener owns browser/desktop dispatch and SSH localhost rewriting for both views. File hover/activation shares the native resolution cache/target conversion and workspace open callback, including outside roots, directories and line/column positions; Command/Ctrl-click or keyboard activation opens a resolved path, while ordinary clicks retain selection. Candidate budgets remain separate for paths and URLs. Rendered text retains bounded source offsets into the shared native per-character cell map, including wide and combining glyphs. Browser glyph hit-testing maps a click through proportional wrapping and Markdown emphasis to its original terminal cell; xterm encodes the mouse press/release with the original modifiers. This is generic text anchoring, with no Codex disclosure-label rules. Link opening takes precedence, selection drags remain browser actions, and mismatched width, viewport, buffer or row text suppress stale clicks. Generated rich-output text and non-mouse layouts retain Show CLI for native interaction. Pinned prompt summaries also accept Enter/Space. Browser checks cover destination integrity, file opening, generic glyph coordinates and stale-click rejection; isolated Codex 0.166.0 sessions verified a collapsed-output click opening the real detail view and a pinned-summary click restoring its original multiline prompt. Mermaid/LaTeX source uses the existing detector, themed renderer, serial queue and security settings at natural reading size, without source toggles. Already-rendered terminal diagrams/formulas remain glyphs; Ripple cannot recover source, collapsed content or history the CLI has not drawn. Codex's explicit copy response can contain original Markdown via OSC 52; that is not a continuous source feed and Ripple never initiates clipboard requests. The opt-in `node packages/web/test/dev/ripple-live.mjs` check launches a direct isolated Codex PTY against the UI preview, never puddled, and verifies real scrolling, styles, native editing, boundary dragging and resizing. `RIPPLE_CODEX_CWD` resumes a previous test directory without another model turn. Provider-shaped browser fixtures cover all four adapters. Additional live verification used Gemini 0.67.0 with its built-in fake-response mode and OpenCode 1.19.5 with an imported synthetic conversation, each in temporary configuration/data directories, including native history scrolling and return-to-latest with an unsent draft preserved; Claude 2.1.318 showed its submitted prompt and native input, but successful model-response verification was unavailable because its login had expired.
- **Session menus**: group Rename, Resume/Kill and Archive/Unarchive first; Runtime (without ellipsis), Renderer and Clear captured env second; account moves, handoffs and worktree/editor actions third. The shared dropdown and context-menu presentation use the same ordering and action policy.
- **Inline diagrams and maths**: complete blocks in terminal output render Mermaid and LaTeX directly over its source cells, using the Markdown preview's token-themed Mermaid renderer and KaTeX (`trust: false`, DOMPurify). Recognise complete `mermaid` fences, unfenced `flowchart`/`graph` and `sequenceDiagram` declarations (agent renderers often strip fences), inline `$…$`/`\(…\)`, display `$$…$$`/`\[…\]`, and `math`/`latex`/`tex` fences. Ordinary code fences, code spans, escaped dollars and currency remain literal. Inline expressions crossing physical rows remain literal when their rectangle would obscure surrounding prose. Terminal diagrams use compact layout spacing to retain legible labels. Each rendered block fits within its original rows without changing PTY bytes, grid size, scrollback or input. A hover source toggle exposes the original cells; coarse pointers keep it visible. Local selection and find selections reveal the source automatically. Incomplete or invalid expressions stay readable as source. Renderers load only when matching content exists, reuse Markdown's serialised Mermaid queue and security policy, and refresh on theme changes. Detection batches active-buffer scans at 120 ms during output, including replay, with at most 128 context rows on either side of the viewport, 32 Ki characters and 32 visible blocks. Scroll/resize/buffer switches rebuild the projection; output immediately hides stale overlays while waiting for the new buffer, while source signatures retain unchanged diagrams through unrelated TUI updates. Hidden or parked terminals perform no rich rendering. No source recovery is attempted when an agent has already converted a formula or diagram into other terminal glyphs.
- **URLs**: a custom xterm.js link provider for plain-text HTTP(S) URLs, plus a custom `linkHandler` for OSC 8 hyperlinks (how Claude Code prints its URLs) — both open through the same path; without the handler xterm's built-in OSC 8 fallback showed a native confirm() and then opened a blank window whose location it assigned, which the desktop shell's window-open filter denies, so accepting the dialogue opened nothing (fixed 2026-08-05). URL and file-path providers share the bounded per-character buffer-cell mapping, so soft wraps, indented TUI hard wraps and resize reflow retain the complete target from every visual row. URL hard-wrap inference requires an unfinished URL at the right gutter (up to eight cells) or a slash followed by a path-shaped continuation; blank lines, new URLs and prose boundaries stop the join. Balanced URL parentheses, IPv6 brackets, query escapes and fragments are preserved; enclosing prose punctuation is excluded. Plain click (or cmd+click—match both) opens in a new browser tab. In SSH mode, URLs pointing at `localhost:<port>` on the host are rewritten to the tier-2 proxy path so they work from the client; in local mode they are left untouched. The SSH-mode signal is the `?host=` boot param the CLI sends at connect time; a local `puddle launch` boot clears any host stored by an earlier SSH launch on the same origin, so the mode can never go stale.
- **File paths**: a custom xterm.js link provider (`registerLinkProvider`) matching `path(:line(:col)?)?` patterns. A token is path-shaped when it has a prefix (`/`, `~/`, `./`, `../`), contains a `/` (a multi-segment relative path like `.worktrees/hil-demos`), or is a bare filename with an extension (`src/foo.ts:12:3`) — so extensionless directories and files light up too, while plain prose and decimals stay quiet. A leading `@` (Claude Code's file-ref syntax, `@~/notes.md`) is stripped. Paths remain one link across soft wraps and TUI line breaks, including repeated continuation indentation, a right gutter of up to eight cells, and deliberate breaks before or after a directory separator. Directory components containing spaces and paths enclosed in quotes, parentheses or brackets retain their full spans; ordinary tokens and standalone absolute paths remain resolve-validated fallbacks. Matching retains a per-character buffer-cell map, so wide glyphs, combining characters and terminal resizing cannot shift the clickable range. Scan at most 32 rows in either direction and 2,048 characters per candidate window; validate joined paths before activation and retain individual-line alternatives when neighbouring text is unrelated. On hover, validate via `GET /resolve` before underlining (the real filter — a false positive just never underlines); on cmd/ctrl+click, open the target. The command palette's **Open path** action accepts the same host paths directly, resolving relative input from the Files sidebar's bound worktree or project-directory fallback. Both entry points share the resolver, while directory opening reflects their intent: a terminal link to a directory enters a pinned browse there; **Open path to a directory already inside the bound worktree/directory target keeps that tree, surfaces Files, expands every ancestor and the directory itself, selects it, and leaves the current pin unchanged**. **The whole daemon host resolves, not just the worktree** (15.2): relative paths resolve against the worktree/directory target, `~` against the daemon host's home, and absolute paths as themselves — only a path that names nothing 404s (the pre-15.2 escape-collapses-to-404 rule is retired; the browse machinery already serves any absolute root, 12.3/12.4, so confirming existence added no capability). Target containment decides the SHAPE of the answer: a file inside opens the ordinary worktree tab (or a rooted `external` tab for the project-directory fallback); a file outside returns `root` + relative `path`, opens an **`external` tab** (§8), and makes its containing directory the shared Files / Search / Changes location; a directory returns `kind: 'dir'` with its absolute path and, when contained, its optional root-relative `relative_path` (16.1). A directory outside the target — or any terminal-linked directory — **binds the file tree to it as a pinned browse**: the same state the `..` walk enters, so unpinning leaves the browse and **Back to the worktree releases the directory pin as it returns**. Every directory path surfaces Files (uncollapsed, or the overlay on a phone) so the result is visible. Containment is checked against the raw target root and its realpath (macOS tmpdir symlinks make agents print either spelling); a symlink inside the target still reads as inside, as the explorer treats it.
- **Image paste**: pasting an image into a terminal (an `image/*` clipboard item with no text alternative — screenshots, copied images) uploads the bytes via `POST /api/worktrees/:sid/paste` into the session worktree's `.puddle/pastes/` (git-excluded like the rest of `.puddle/` — §4) and inserts the returned worktree-relative path into the terminal's stdin, unsubmitted, for the agent to read. This is what makes image paste work in SSH mode: the agent's own clipboard read (e.g. Claude Code's Ctrl+V) happens on the host machine, whose clipboard does not hold the client's image — so the bytes travel over the API instead. Works identically in local mode; mixed clipboards (text + image) keep xterm's normal text-paste path. Capped at 20 MiB; png/jpeg/gif/webp.
- **macOS line editing**: on Mac clients the browser eats ⌘←/⌘→ (history back/forward) before the PTY sees them, while xterm encodes ⌥←/⌥→ as `CSI 1;3D`/`CSI 1;3C`, which stock macOS zsh does not bind and therefore leaks as literal `;3D`/`;3C` text. A custom xterm key handler sends portable Readline/ZLE controls instead — ⌘← → `Ctrl-A` (line start), ⌘→ → `Ctrl-E` (line end), ⌘⌫ → `Ctrl-U` (delete to start), ⌘⌦ → `Ctrl-K` (delete to end), ⌥← → `Meta-B` (previous word), ⌥→ → `Meta-F` (next word) — matching native macOS field behaviour. Applied only on Mac, so Meta/Super and standard Alt-modified cursor sequences are untouched elsewhere.
- **Terminal copy/paste**: **⌘C** on Mac and **Ctrl+Shift+C** elsewhere copy the terminal's local selection, falling back to the most recent stashed OSC 52 payload. **Ctrl+C** also copies when either selection is available; otherwise it retains the application's interrupt/copy behaviour. **Highlighting alone never touches the browser clipboard**: unsolicited `OSC 52 ; c ; <base64>` writes are stashed until an explicit copy gesture. Mouse-aware applications can produce their selected text only after receiving a copy key. With no local text, forward the actual chord (CSI-u Super+C or Ctrl+Shift+C; plain Ctrl+C remains ETX), reserve a browser clipboard write during the gesture, and accept one OSC 52 reply within two seconds. Together with the Codex adapter's terminal clipboard setting (§5), this covers normal drag selection over SSH without needing a second copy press. Command+C never becomes an interrupt. Desktop **Edit → Copy** follows the same path through the native copy event. A selection consisting solely of one HTTP(S) Markdown link or autolink copies its destination as plain text, including stashed/delayed OSC 52 replies and touch Copy; surrounding prose and other Markdown remain literal. A locally selected complete wrapped URL is joined only when it matches the buffer link, removing the TUI gutter and line breaks without expanding partial selections. Typing, a new mouse selection, focus loss, replay, detachment and terminal disposal cancel pending copies and clear stashed text; inactive/replaying viewers ignore OSC writes. Clear/malformed payloads invalidate the stash; OSC 52 read requests (`?`) never read or send the client clipboard. Clipboard permission failures are visible and leave the received text available to retry. The bridge handles terminal output only: an application which writes the daemon host's native clipboard without OSC 52 remains outside the browser's reach (see the Claude Code adapter's copy-on-select finding). **⌘V** uses xterm's native paste event (text through its normal path, images through `/paste` above). **Selection under mouse-reporting TUIs**: ordinary drags remain application-owned; **Shift+drag** forces a local selection on non-Mac clients; Mac clients use **⌥+drag** (`macOptionClickForcesSelection`).
- **In-view find**: **⌘F** on Apple clients and **Ctrl+F** elsewhere opens the same compact find widget over every xterm surface (agent, terminal, login, and dashboard shells). The official xterm search addon searches the complete retained scrollback, follows soft-wrapped lines, highlights all matches, selects and scrolls to the active one, and updates as output arrives. Enter / Shift+Enter and the arrow controls move next / previous with wraparound; case, whole-word, and JavaScript-regex toggles match the rendered-file control (§8); Escape closes it and restores terminal focus. On macOS plain Ctrl+F remains a PTY key (readline forward-character) rather than being stolen as a second find binding.
- **OSC 7733 is puddle-internal**: session shells report captured-env changes over this side-channel (§4), which the daemon parses and strips at the PTY-output choke point — before recording and broadcast — so the web terminal, `puddle attach`, replay, and the on-disk logs never see it.
- **Open in editor**: a session's menu offers "Open in VS Code" / "Open in Cursor", each a deep link opened via `window.location.href` (not `window.open`, which would pop an unwanted blank tab for a custom scheme handler). Local mode: `vscode://file<worktree_path>` / `cursor://file<worktree_path>` (the worktree path is absolute, so plain concatenation already yields the correct single slash; each path segment is percent-encoded with `encodeURIComponent` so spaces/`#`/`?`/`%` in filenames can't corrupt the URI, while the `/` separators stay literal). SSH mode: `<scheme>://vscode-remote/ssh-remote+<host><worktree_path>` — the host is minimally escaped (only `%#?` and space) so `user@host:port` keeps its literal `@`/`:` for the remote-authority parser; VS Code and Cursor share the same remote-authority scheme since Cursor is a VS Code fork. Host precedence: the client setting (Settings → Editor → "SSH host for editor links") beats a captured `?host=` boot param (stored in `localStorage`, stripped from the address bar) beats local mode. The CLI sends `?host=` at connect time; for a manual `ssh -L` tunnel it never covers, the client setting is how a host gets configured.

## 8. Editor, diff, and git history

**Embedded preview drag shield.** While a strip drag is active, every pane body carries a transparent interaction shield so an HTML iframe cannot swallow the pointer and make that pane unreachable. Generated LaTeX PDF tabs remain ordinary persistent external tabs: they move, reorder, and edge-split into any pane through the same layout reducer as every other file tab.

**Control trays.** Related controls share `ControlTray`, common geometry and theme-token fills. Navigator mode trays use `--bg-elevated` and the host accent for the selected mode (gold when unset). Action-only groups have hover feedback without a selected mode: header/notebook actions remain unfilled, while expanded new-session controls have the navigator tray fill. Collapsed control trays and project/session groups use `--bg-tray`, with a brighter navy step in dark mode. Filled trays have the shared island outline and surface radius; floating PDF zoom controls retain their overlay backing. Collapsed sidebar toggles sit above a horizontal separator inside their trays, aligned with the pane islands. The archive target is a separate full-rail-width island at the bottom.

**Shared geometry and file presentation.** The shared Files/Search/Changes target heading shows the folder basename in bold at the file-tree row font size. Long names scroll from the left, resetting on location changes; the tooltip sits immediately to the right and shows the absolute path. Row height, tab-strip height, control height, corner radius, list inset and icon gap live in `--ui-*` tokens, with compact density overrides. Search and Changes reuse explorer file-type icons; Git badges remain independent. Search, Changes, Worktrees and expanded session rows use the same rounded list insets, while multi-line session rows can grow vertically. Collapsed session marks are 20px normally and 16px in compact density, before UI scaling.

**Header boundary.** The header is one inset, rounded, outlined island using the shared surface tokens. Identity and workspace actions share the background with a full-width clickable command area, separated by short centred vertical lines. The command label and shortcut remain centred relative to the screen; hover fills the available central section. There is no horizontal divider below the header, and its workspace gap matches other islands. Native desktop title-bar height and traffic-light placement are preserved.

**Floating workspace.** Pane frames, expanded sidebars, filled trays, dashboard tiles, the home terminal, dialogs and popouts use a one-pixel inset outline from `--border` without changing layout dimensions. Overlays retain their shadows. The Settings navigation retains its vertical divider. Surfaces share `--ui-surface-radius` and gaps share `--ui-surface-gap`; shell ground is `--bg-base`, while pane frames and tab strips use `--bg-surface`. Active tabs and editor interiors use `--bg-base` (white in light mode). Collapsed sidebars contain floating icon groups rather than full-height panels. Expanded repository/project groups have no individual fill or outline and are separated by horizontal dividers. History and Archive are separate sibling islands, with transparent resizing gaps; History fills the remaining height and Archive stays anchored to the bottom. Workspace split handles remain operable without visible lines.

**Editor surfaces.** Each editor pane has a small side/bottom inset and rounded corners using the shared radius token. Source editors, diffs, notebooks and document previews share the clipped surface beneath the floating tabs, with a further 4px interior inset so line highlights do not meet the outer background. Terminal bodies retain the outer inset framing and their existing resize observation. Ordinary source editors reserve one line-number digit initially, grow automatically with the model's line count, add a small left inset and reserve 5px for decorations plus Monaco's folding controls.

**Pane tabs.** Active tabs float inside the strip with rounded corners on all sides and space above and below. Tabs are separated by space, with no divider lines. Hover controls preserve the rounded shape. Dragging blank tab-strip space moves the entire pane with its tabs, active tab and preview state intact: centre drops swap panes, edge drops place the pane beside the target. Self-drops, drops outside the grid and Escape cancellation leave the layout unchanged. Individual tabs retain their existing drag behaviour.

**Session tab controls.** Hovering an agent or terminal tab reveals Stop before Close while the session is starting, running or waiting for input; exited or interrupted sessions instead show Resume, Archive and Close. The controls use the same overlay and styling as a file tab's preview control, and coarse-pointer devices keep them visible. Resume is disabled when the worktree or native conversation is missing. Stop, resume and archive use the existing session mutations without confirmation, disable lifecycle actions while pending and report failures; resume follows an existing live conversation when the daemon identifies its placement. Archive closes the session's tabs only after success, including when a session update has already unmounted the archive button. Empty split panes collapse through the normal tab-close behaviour; closing a tab alone retains the session.

Notebook execution observation (26.3) accepts an optional known run id/revision,
or null for a previously empty run. An exact match returns only `unchanged: true`
without encoding cell sources or outputs. Omission and changed observations
return the full existing snapshot. Older clients retain full responses; newer
clients only opt in on supporting hosts. First observation, reconnect,
invalidation and recovery from a failed read obtain full snapshots. Idle and
completed notebooks continue discovery at five seconds; running ones use 250 ms.
Unfocused windows use the shared 12× slowdown and focus restores fresh reads.
Cancellation affects observation only and never submits/replays execution.

**Workspace layout.** Three columns: a **left navigator** whose top is a horizontal icon row — Files · Search · Changes · Worktrees — with the collapse control on the right of that row, over the selected navigator's content. Collapsed, the navigator becomes a slim rail of those same icons stacked vertically; clicking one expands the sidebar straight to that navigator (state persisted in `ui_state`). A **centre** is a free-form **tiling area** — one surface **per project** by default, or one shared across the profile's projects with `projectBasedLayout` off (§11 reload semantics) — where editor tabs (files, diffs, commit diffs, media) and agent terminals share one space: a tab drags along a strip to reorder (a caret marks the insertion point), onto a pane's body to move into it, or onto a pane's edge to split it (top/bottom/left/right) into an arbitrary recursive grid of resizable panes (VSCode editor-groups style). A STRIP drag (the tab chip itself) always **moves** — file tabs exactly like terminals, leaving nothing behind in the source pane; another pane's tab of the same file is an independent tab and stays put (the move takes the key from the source leaf only) — while a SIDEBAR drag **opens** (decision 2026-08-06, `DropSpec.copy`): the file tree names content, not a pane, so dropping a file already open elsewhere grows a second tab of it (both share one refcounted buffer) instead of yanking the first out of its pane — which is also what makes the same-file split possible (edge-drop a pane's only file onto its own edge; move semantics collapsed that to a no-op). Within ONE pane a tab stays unique — a copy-drop into a pane already holding the file focuses it — and a session tab is one live PTY, so it always moves whatever the gesture. Every drop **pins**: a preview tab deliberately placed stops being ephemeral. The sidebars feed the same engine: a file row from the tree or a session from the right sidebar (row or collapsed rail glyph) drags onto a pane and drops through the identical zone geometry — centre inserts, an edge splits — opening a PERMANENT tab, so one gesture opens and positions at once (a dropped session also claims the URL). These sidebar drags ride native HTML5 DnD (the tree and the session list already are native draggables, for internal moves and reordering) with a zod-validated `application/x-puddle-tab` payload; pane-to-pane tab drags keep their dnd-kit path. Terminal portal containers stay stable and their DOM is adopted into whichever pane shows them, so an immediate move never rebuilds the viewer or drops a PTY; open editors share one refcounted model per file. **Preview tabs** (VSCode-style): single-clicking a file, session, or terminal opens it in one reusable _preview_ slot per pane (rendered in italics) that the next single-click replaces once the pane has multiple tabs; a lone tab is retained when a second item opens; double-clicking the item — or its preview tab — pins it permanently. A slot showing a **rendered** view stays rendered (decision 2026-08-05): the file replacing it inherits `view: 'preview'` when it too has a rendered view, so a directory of markdown can be skimmed by single-clicking down it instead of toggling every arrival one tab at a time. A view the caller names explicitly (the ⌘-clicked link out of a preview) wins, and a file with no rendered view inherits nothing. **Every list that opens content behaves this way** (decision 2026-08-03), not just the files tree: an uncommitted change, a file inside a commit, and a search hit all peek on a single click and pin on a double, so scanning a result list leaves one tab behind rather than a strip of them. A preview **terminal** is never silently discarded (it is a live PTY): opening something else pins it and opens the new tab alongside, so an agent you were watching can't vanish under a click. The tree persists in `ui_state.layout_tree` (a leaf's `previewKey` names its ephemeral tab; legacy snapshots migrate to an equivalent editor-over-terminal split). **Double-clicking a strip's blank tail** — or the `tab.newUntitled` hotkey (⌃⌥N; plain ⌘N on desktop), which targets the focused pane — opens a fresh **untitled draft** in that pane (10.3) — deliberately **worktree-agnostic**: the content lives in the profile's own store (`profiles/<id>/untitled/untitled-<n>.md`, `POST/GET/PUT/DELETE /api/profiles/:id/untitled[/:name]`), persisted continuously (debounced) while edited, so it survives reloads and follows the profile across machines. Its tab (`kind 'untitled'`, `session` = the nil uuid — it binds to no worktree, and the sidebar falls back to the URL session while it is focused) rides the ordinary tiling machinery. **⌘S opens a save-as dialogue** targeting the sidebar-bound worktree: pick a worktree-relative path (never overwrites an existing file), the draft is written there, deleted from the profile store, and the tab swaps to an ordinary file tab. **Closing** an untitled tab asks first, then discards the draft — nothing lists orphans, so the tab is the draft's only handle. And a **right sidebar** lists the project's sessions — "session" is the umbrella over both kinds, agent and terminal (§4); the creation affordances say **"New agent"** (robot icon) and **"New terminal"**, in the sidebar header and the ⌘K palette alike; the header's symbols read **Agent · Terminal** — each creates a session (the Scratchpad is a top-bar popover, §11, no longer a sidebar view; the old `ui_state.right_panel` key remains in the schema for wire tolerance but nothing reads it) (header mirrors the left navigator: the collapse control on the left edge, the Agent · Terminal controls on the right; collapsible to a slim rail that keeps the reopen, new-agent, and new-terminal buttons, then — below a divider — one clickable session glyph per live session so you can switch sessions without reopening the sidebar, the active session's glyph carrying the same `bg-elevated` fill-shift that marks the active session when expanded — no border). In the expanded list the active/hover row bleeds its fill to both sidebar edges, and each row's actions menu (⋯) reserves no width until the row is hovered (so the title/branch/badges use the full width). The same lifecycle menu (resume/kill/rename/archive/unarchive/move/open-in-editor/open-terminal-in-worktree/spawn-agent-in-worktree — the last two spawn a session that joins the session's worktree directory: a plain shell, or an agent on a chosen account picked from a submenu whose first entry is the profile's default account, so opening it and pressing Enter spawns the default, §4) also opens on **right-click** of a session wherever it appears — the expanded row, the collapsed rail glyph, or its tab in the top strip. Archived sessions are not shown inline; they collapse under an **Archived** disclosure at the bottom of the list, where each still carries the ⋯ menu to **unarchive** it (§4). Open, the pane **groups by project** exactly as the live list does (same project order, a dimmer inert header — finding a session again is the job, not navigating), each row trading its account line for **when it was last active**, and its top border **drags** to give the pane more or less of the sidebar (decision 2026-08-04; the height is per-browser in `localStorage`, capped against the sidebar so it can never swallow the live list — `components/resizable-height.tsx`, which the Changes navigator's uncommitted/History border uses too). **Archive-by-drag** (decision 2026-08-03): a session dragged onto the Archived header — or, collapsed, onto the **archive icon at the rail's foot** (which a click expands) — is archived on drop, no confirmation (nothing is destroyed, §4). Both payload paths land there: the sidebar's own rows and rail dots (native `application/x-puddle-tab` drags) and the centre strip's terminal tab chips (dnd-kit — the tiling DnD context wraps the whole workspace so its drags can leave the panes); editor tabs are ignored. While a session drag is live the Archived header shows even with nothing archived yet, so there is always somewhere to drop. By default the sidebar shows **every project's sessions**, grouped by project — a clickable project-name header when expanded, a divider plus a five-character project label on the collapsed rail — the project order inheriting the homescreen's `profileSettings.projectOrder` (§11); a click navigates into that session's own project. **Two INDEPENDENT per-browser client settings** decide the scope (Settings → Appearance; they were one setting through v0.0.24, which forced an editor layout choice on anyone who only wanted a focused session list — decision 2026-08-03, and `client-settings.ts` reconciles a stored snapshot of either vintage in both directions so neither behaviour flips under an upgrade). `showAllProjectSessions` (default ON) is this list: off, it lists only the current project's sessions, keeping every project name as a navigation target either way, and the Archived disclosure follows it — every project's archived sessions in sidebar project order when on, only this project's when off — **except under a project-based layout, which always keeps the disclosure to its own project** (decision 2026-08-05: that mode's whole premise is a window about one project, so another project's archived session offers nothing to do here). Within a project the disclosure is ordered **newest conversation first**, by the same last-activity timestamp its rows show (falling back to creation), and takes no saved drag order — nothing is dragged into it, and "what was I last doing" is the only question it answers. `projectBasedLayout` (default ON since 2026-08-04) is the CENTRE: on, the tiling area persists **per profile and project** instead of one shared surface (§11 reload semantics) — returning to a project brings its own panes back, which is what a project-shaped workspace implies; off, one surface follows you between projects. Either combination is expressible, including a per-project layout beside a cross-project session list. The session list scrolls **without a visible scrollbar** while the controls stay fixed, so a long list still works; a collapsed glyph's tooltip shows the session name over its branch. The list is **drag-reorderable** in both views — within a project's group in the cross-project view (a session never changes project by drag), and in the collapsed rail just like the expanded rows — persisted per-profile in `ui_state.session_order`; a newly created session appears at the top of its group until dragged (the ordering keys on session id, so it applies uniformly to every session type). Changes and Search are _navigators_, not full views: each is a list, and selecting an entry opens its content as a centre-editor tab, so the editor is the single content surface. The pin binds the **whole sidebar** to one worktree — Files, Changes, and Search all follow it; unpinned, the sidebar follows the **focused pane's active tab**: every tab carries the worktree it was opened from (a file/diff tab its `session`, a terminal its own session), so clicking into an editor or a terminal body — like clicking its strip chip — re-binds the file tree, search, and git views to that tab's worktree (a terminal click also claims the URL), with the URL-bound session as the fallback for an empty pane. **When nothing qualifies the sidebar binds to the PROJECT'S OWN repository directory** (decision 2026-08-03): a project whose sessions are all archived, one with none created yet, or simply none in focus used to leave Files, Changes, Search, and History empty — four blank panels while a project was open, which is always. The fallback is a **directory target** (protocol 12.4): the nil session id plus `?root=`, so every navigator keeps the props it already takes for a worktree and the daemon resolves the directory from the root (§6 API). It is a full binding, not a preview — the tree mutates, files open and SAVE (as `external` tabs, the kind whose identity and requests carry a root), Changes shows the directory's own uncommitted work, History its commits, Search greps it, and ⌘S places a draft in it. Two things are genuinely session-shaped and stay absent: the **pin** (there is no session id to pin — it is the fallback, so nothing can pull the binding away) and **Open Terminal in Directory** (the daemon confines a terminal's `cwd` to a worktree, 11.1). On a daemon older than 12.4 the empty state stands, since it would answer git questions about the wrong repository. The header under the icon row names the one **absolute current file-tree location** shared by Files, Search, and Changes (with the daemon home ~-compressed so the identifying tail gets the width), and carries the pin toggle (a solid glyph when pinned; left of the worktree dropdown) plus the dropdown to bind another. **Parent-directory browsing** (10.2, editable 10.4): a `..` row under the Files header walks ABOVE the worktree into a browse tree (`?root=` on the file routes) — expand directories, keep walking up, open files as **`external`** tabs (`editorTabRefSchema.kind 'external'` + its absolute `root`; media renders through the same viewer, and markdown/HTML get the same source ⇄ rendered-view toggle — the preview pipeline keys its buffer and routes its media/asset fetches by the same `(session, path, root)` the source editor uses, and a ⌘-clicked link inside a rooted preview opens its target against the same root, decision 2026-08-06). External tabs are **full editors**: the shared buffer store, IndexedDB drafts, cross-window peer sync, the model refcount, and the conflict-safe save (409 `stale_file` → reload/overwrite) all key by `(session, path, root)` — the root is part of the buffer identity, or a rooted file and a worktree file sharing a relative path would silently share one buffer — and the save PUTs with the same `root` its GET read. The browse tree **is** the worktree tree (12.3, decision 2026-08-03): it mounts the same `ExplorerProvider`/`FileExplorer` with a browse root instead of a worktree, so every right-click affordance works above the worktree too — New File/Folder, Rename, Delete, cut/copy/paste, drag-move, drag-in upload, Download — because the fs mutation and upload routes take the same `?root=`. Root-qualified Git-status queries keep decorations honest there; the one genuinely worktree-shaped action that stays absent is **Open Terminal in Directory** (the daemon confines a terminal's `cwd` to the worktree, 11.1). On a daemon between 10.2 and 12.3 — which serves the browse tree but would resolve a mutation against the WORKTREE — the tree goes **read-only** (menus keep only Copy Path and Download) rather than silently touching the wrong files. The shared location header renders inside the browse tree's provider, so its Refresh · Collapse Folders utilities drive that tree too. Entering the browse **pins the sidebar** so follow-the-active-session cannot yank the tree away mid-browse; the browse state itself is ephemeral (a reload lands back on the worktree). While browsing outside a worktree, the shared navigator header becomes that browse root; a compact row below offers `..` to walk up and a return button to leave the browse. A file dragged out of it into the tiling area opens as an `external` tab carrying the browse root, not a worktree `file` tab.

**Sidebar multi-selection.** Live sessions are multi-selectable in both the expanded right sidebar and its collapsed rail. An ordinary click establishes the range anchor while keeping its normal navigation, Shift-click selects the inclusive visual range without navigating, and ⌘/Ctrl-click toggles one session; the selection uses the theme's selection fill and survives collapsing or expanding the sidebar. Right-clicking a selected member replaces its single-session lifecycle menu with a batch menu (`Archive all`, with the selection count), while right-clicking outside the selection first selects only that session. Dragging any selected member carries the whole selection to either archive target under a validated companion `application/x-puddle-sessions` payload and shows a count drag image. A multi-drag does not reorder the list; the grabbed session's existing `application/x-puddle-tab` payload remains beside it so a pane drop can still open that one session.

**Save follows logical tab focus** (decision 2026-08-10): the save shortcut always targets the focused pane's active tab — an ordinary file saves its shared buffer, while an untitled draft opens save-as only when that draft itself is active. The shell captures the shortcut before Monaco because clicking a draggable tab chip can change logical pane focus without moving `document.activeElement`; a Monaco editor in another pane must never save merely because it retained the DOM caret.

- **File explorer** (the Files navigator): the tree is always bound to exactly one worktree — there is no merged project-wide view. By default it **follows the active session** (via the shared sidebar binding above): switching session tabs switches the tree to that session's worktree. The sidebar pin locks the binding to a chosen worktree (so you can read session A's files while watching session B's terminal); unpinning re-enables follow-the-session. The row for the file open as the active editor tab (when that tab belongs to the bound worktree) carries the `bg-elevated` active fill, so the currently-open file is highlighted in the tree. **Folder rows carry their own name as a tooltip**: directory names are the ones that run long (dated or slugged directories), and in a narrow tree an elided folder name has nothing else in the row to read it from, while an elided FILE at least names itself on the tab it opens.
  - **Git decorations**: `GET /git-status` (a whole-worktree `git status --porcelain` map, polled like the diff view) drives per-row colour + a one-letter badge — `U`ntracked/`A`dded (success-green), `M`odified/`R`enamed (warning-amber), `D`eleted/`C`onflict (interrupted-red); ignored-but-present files dim to `fg-muted` with no badge, and a folder is tinted by its highest-priority descendant. The status set is a distinct `GitStatus` schema (not `DiffStatus`), which the tree also uses for the folder roll-up.
  - **File-type icons**: a locally bundled Material Icon Theme SVG subset, matched by filename, configuration prefix and extension (including compound TypeScript declaration suffixes), with upstream colours and a muted generic fallback. Ignored icons are dimmed. Editor tabs reuse the same file-type icons before their titles, including external files and diffs; untitled drafts use their displayed name. Linked/locked preview markers remain alongside the type icon. The navigator uses filled folders in the theme foreground colour, muted disclosure arrows, 16px nesting, inset rounded neutral selections and borderless hover fills; normal/compact rows are 30px/26px at the base UI scale, with 8px gaps between icons and labels. Git colours apply to filenames, status badges and folder icons (including descendant roll-ups); symlink folders retain a link overlay.
  - **Symlinks**: `/tree` resolves a symlink to its target kind, so a link to a directory is explorable and a link to a file opens; the entry carries a `symlink` flag and the tree draws the link icon at the symlink's own row (its children keep their normal icons). Symlinks are **followed even when their target is outside the worktree** (read + write) — a symlink is a real object the user placed in the worktree, and puddle runs as that user. The containment guard (`containedPath`, shared by every file route and the terminal-link `/resolve`) rejects only lexical escapes: absolute paths and `..` climbing above the root. Because `..` normalises lexically _before_ any link is resolved, following a symlink reaches exactly its target subtree, never a sibling or parent outside it. Only a broken/unresolvable link (or a non-file/dir target) stays a non-expandable `symlink` leaf.
  - **Context menus** (files, folders, empty space): the scrollable tree leaves 2.5 row heights of blank space below its last entry, scaled for normal and compact density, so the root menu stays reachable even in long lists. Menus match VSCode within the remote-web model: Copy Path / Copy Relative Path, Cut / Copy / Paste, Rename / Delete, Download; folders and empty space add New File / New Folder plus **Open Terminal in Directory** (a new terminal in the current worktree, `cd`-ed to that directory — the worktree root for empty space). Every path-backed editor tab (`file` or `external`, never an untitled draft) opens those same file rows on right-click, plus **Reveal in Filetree**: when the file's absolute path is already inside the visible Files root, that root stays put and the tree expands/selects the root-relative path (including generated PDFs below the local `.puddle`); otherwise a worktree file binds Files to its owning worktree and an external file temporarily rebases Files to the file's containing directory before selecting it. Choosing **Rename… on a tab edits the filename inline in that tab chip** (basename selected; Enter or blur commits, Escape cancels), renames it on disk, and retargets every open live view of the same buffer while preserving unsaved text and undo history; it does not move focus into the Files sidebar. Local-host cockpits add **Reveal in Finder / File Explorer / File Manager** (protocol 24.2) to file/folder rows, empty space and path-backed tabs. It acts on the clicked entry: folders open in the native file manager and files are selected in their containing folder. Absolute paths follow the effective worktree or browse root, including external tabs and symlinks. The browser and Electron shells share the authenticated cockpit-local `GET/POST /cockpit/file-manager` route; only an actual local connection advertises the capability, never an SSH cockpit merely served at localhost. The POST rechecks browser authority after path inspection, bounds concurrent dispatch, passes literal arguments without a shell and reports failures as toasts. Linux uses FileManager1 selection when available, falling back to opening the containing folder on minimal desktops. Older cockpits and remote/mobile transports omit the action. Share remains omitted; Open to the Side awaits the tiling-layout work.
  - **Mutations**: create / rename / move / copy / delete ride confined endpoints (below). Cut/copy state is a device-local browser clipboard, shared by same-origin Puddle windows and retained across project/filetree switches and reloads. Paste within its source filetree keeps using `/rename` for cut or `/copy` for copy, including against older daemons; filetree identity is the effective absolute directory, so two sessions sharing one worktree stay on that legacy path. Cross-filetree paste on the same daemon host is protocol 16.3's `/transfer`: the request identifies the source session/root independently from the URL-addressed destination; moves use a direct rename when possible and copy fully before deleting the source across filesystems. A newer UI positively feature-detects 16.3 before offering this path, so an old daemon never receives an unknown mutation. Copy auto-suffixes ` copy` on collision; moves reject collisions. Internal drag-to-move and paste both refuse moving a folder into its own subtree. Create and rename edit **inline** in the tree (no dialog, per HUMANS.md); delete is the one confirmation, since the host has no trash.
  - **Selection & keyboard**: ⌘/⇧-click multi-select over a flattened visible-row model; full roving arrow-key navigation (↑↓ move, →← expand/collapse/step, type-to-jump), plus `F2` rename (files: also a **second single click on the already-selected row within ~1.5 s**, Finder-style — deferred a beat so a double-click still pins instead (`lib/second-click.ts`); folders: **no click gesture at all** — the context menu's Rename… and `F2` are the whole story, because a folder's clicks belong to expand/collapse and every gesture tried fought that, the second-click timer firing mid-toggle and the double-click variant opening a rename box whenever a folder was flipped open and shut quickly — decision 2026-08-04), `⌘⌫` delete, `⌘C/X/V`, `⌥⌘C` / `⌥⇧⌘C` copy (relative) path. Every action **respects the multi-selection** when the clicked/grabbed row is in it — cut/copy/delete, drag-to-move (a JSON list payload with an "N items" drag chip), Download (one download per entry, sequential), and Copy (Relative) Path (one per line); a selection holding both a folder and its descendants is pruned to the folder before acting.
  - **Header utility bar** (files mode): Refresh · Collapse Folders, plus the pin and worktree-picker controls — creation (New File / New Folder) lives only in the context menus. At rest these are hidden and the shared navigator title — the current file-tree location's **absolute path** in Files, Search, and Changes — spans the full width (no hidden control reserves space — the pin stays shown while pinned to keep that state visible); on header hover/focus they surface as an overlay at the right edge, and the title, a marquee, eases leftwards to reveal any tail the overlay covers.
- **Editor tab identity is (kind, session, path[, root, sha])**, not path alone: a `file` editor, a worktree `diff`, and a `commit` file diff are distinct tabs even for the same path (labelled `api.ts` · `api.ts (diff)` · `api.ts @1a2b3c4`). And `src/api.ts` in two worktrees is two different files with independent dirty state — tabs suffix the branch when the same basename is open from more than one worktree (`api.ts — alice/fix-auth`); when those branch labels are themselves equal, the absolute worktree paths disambiguate them. Same-basename paths within one session show their relative paths, while two external files with the same root-relative path under different roots show their absolute paths, so physically different files in one pane never present indistinguishable labels. `file` and `diff` tabs share the one editable buffer for their `(session, path)`; `external` buffers additionally key on `root`; `commit` tabs are read-only.
- **Monaco** for file view/edit. Saving PUTs the full file; daemon writes to the worktree so running agents see the change immediately. Editor keybindings are registered in one place (`editor-keybindings.ts`): ⌘/Ctrl+S saves, **⌥Z** toggles line wrap (flipping the `editorWordWrap` client setting so every open editor follows and the choice persists); Monaco's stock multi-cursor / comment / find bindings are kept.
- **Tab view positions** remain independent in bounded browser-window memory, keyed by transport, profile/project layout, pane, tab and rooted target. Source, untitled, read-only, working/staged/history and conflict editors save Monaco scroll, cursor and folding state before disposing models. Returning to a tab restores it; an explicit source-navigation request takes precedence once, without repeating on later remounts. Markdown and HTML retain their own semantic scroll positions before publishing to linked/locked views; receivers still follow the current driver. Mobile text views retain both scroll axes, and shared mobile previews use the same restoration. Loading/zero-sized surfaces cannot replace valid saved positions. These positions survive tab/project switches within the window, not browser reloads, and add no daemon state or protocol fields.
- **Rendered-view find**: Monaco's **⌘F** (Apple) / **Ctrl+F** (elsewhere) entry point also opens a matching find widget in every rendered Markdown or HTML file view, including preview, linked, and locked modes. It highlights all rendered-text matches, scrolls the active match into view, wraps Enter / Shift+Enter and arrow navigation, and offers case, whole-word, and JavaScript-regex toggles; Escape closes it. Markdown uses non-mutating CSS Highlight ranges, so links and sanitised markup stay intact. Sandboxed HTML keeps `allow-same-origin` disabled: a credential-free injected bridge performs the same search inside the opaque-origin document and reports only match state to the parent. Each view caps simultaneous highlights at 1,000 and labels the count as a lower bound when capped.
- **Media viewer** for non-text files: a `file` tab whose path is an image, video, audio clip, or PDF renders an inline preview (`<img>`/`<video>`/`<audio>` or the owned PDF.js viewer) instead of Monaco, fetched from `GET /media` through the authed API. Images/audio/video use an object URL (no token in an element `src`), revoked on close; PDF.js receives the fetched bytes directly, so the remote app needs no blob requests in `connect-src`. Unknown binaries keep the "Binary — use Download" fallback.
- **Compilation providers** (protocol 17.1; command settings 17.3) are daemon-host capabilities, not browser assumptions: the generic daemon registry advertises provider ids, source extensions, open-input extensions, the selected local executor, and eager support. The generic service owns target identity, on-demand/eager mode, status revisions, one-in-flight/one-dirty-run coalescing, dependency observation, artefact descriptors, and project/file/mode settings lookup; a provider owns tool discovery, entry-point resolution, command templates and validation, exact argument arrays, dependencies, managed output, and optional navigation. LaTeX is the first provider (`.tex` sources and `.tex`/`.bib`/`.sty`/`.cls`/`.bst` inputs); adding another compiled type must not add TeX branches to the generic service, tab strip, settings storage, or dialog. Discovery runs on the machine hosting `puddled` — including an SSH host — and searches its effective `PATH` plus bounded conventional TeX Live, MacTeX, TinyTeX, and MiKTeX locations. LaTeX prefers `latexmk`, then Tectonic, then bounded direct `pdflatex`/`xelatex`/`lualatex` passes with bibliography helpers when present. `% !TEX root` and `% !TEX program` accept only confined relative roots and allow-listed engines. Built-in and customised commands are parsed into executable + argv and spawned without a shell, with shell escape disabled by the advertised defaults, a two-minute timeout, a 2 MiB captured-output ceiling, and process-group teardown on daemon stop.

  Dependency observation is shared across eager targets by exact path and parent
  directory, with reference-counted subscriptions and at most eight asynchronous
  stats in flight. Initial baselines complete before the initial build; unchanged
  dependencies retain their baseline across builds. Healthy directory watches
  trigger the existing 350 ms debounce, with ten-second signature verification
  for missed events/VM mounts. Unavailable or failed watches retain a 500 ms
  fallback scheduler, retry attachment every five seconds, and healthy handles
  renew every minute to recover removed directory inodes. Target generations
  discard late observations. Targets without client status/mode/run activity
  expire after fifteen minutes, checked each minute; filesystem changes do not
  extend their lifetime. Active builds and maintenance holds are not evicted.

  A compilable source chip has minimal hover controls beside close: the play triangle performs one on-demand build; when the provider supports it, the lightning mark toggles eager observation, and the active mode is accent-coloured. Clicking either first activates the source so its dirty buffer can be saved. The selected source and every mounted dirty input buffer advertised by that provider in the same rooted file tree are saved before compilation; a conflict or failed save cancels the build. `compile_mode` persists in the ordinary editor-tab snapshot (absent means on-demand) and duplicate source tabs in the live layout are rewritten together. An eager tab registers with the daemon after restore/reconnect, receives one initial build, then compiles settled on-disk changes from Puddle, agents, formatters, or other local processes. Parent-directory `fs.watch` catches direct and atomic-replacement writes, asynchronous stat signatures provide a portable Linux/macOS/WSL safety net, 350 ms debounce coalesces bursts, and a change during a build produces exactly one follow-up run. Switching to on-demand or closing the last eager source view retires its watcher; daemon shutdown closes every watcher and compiler process. Modes are not Markdown/HTML preview modes and never enter linked/locked scroll following.

  **Code execution and notebooks** (protocol 24.3). Providers may advertise optional `action: "run"` (omission means compilation). The `code/` provider recipes cover Python (`python3`/`python`), JavaScript (`node`/`bun`), TypeScript (`tsx`/`bun`), C (`cc`/Clang/GCC/TinyCC/Intel), C++ (`c++`/Clang++/G++/Intel), Rust, Go, Ruby, Perl, R and Bash/Zsh. Discovery uses the daemon host's effective PATH and bounded conventional installation directories, cached for 30 seconds. Available providers expose the same play control and per-file command settings; only providers advertising eager support expose lightning or restore eager watchers. Code always runs explicitly. The source and open provider inputs are saved through the existing conflict checks first. Since protocol 25.0, every programming-language provider advertises `terminal: true`; its only run behaviour opens a fresh permanent terminal placement in the source's project and existing worktree. Each interpreter runs from the source file's directory with literal arguments and interactive PTY input; C/C++/Rust first compile to `{{binary}}` inside a fresh managed run directory, then execute that exact binary only after compiler success. Their custom command overrides the build step and must retain `{{binary}}`; interpreter overrides may add arguments or select another installed environment. No dependency installation or project-build inference occurs. Compiler output, errors and programme interaction appear directly in the terminal. Commands finish at an ordinary shell prompt, including after Ctrl+C; no two-minute execution limit applies. The launch wrapper quotes parsed arguments literally and only chains the provider's known build/run steps. The command is never persisted or replayed on resume or daemon restart. Rooted external files run from their own directory, while the terminal retains the ordinary worktree-relative restart location. LaTeX and notebook artefacts keep their preview flow.

  A terminal run response includes the new terminal placement and no preview artefact; service success confirms launch, while programme exit status appears in the PTY. Terminal runs use the ordinary session lifecycle, log bounds, attach/reconnect, port discovery and shutdown. Source-root-local `.puddle/code/<provider>/<source-hash>/runs/<id>` holds generated binaries and output; live terminal directories are retained until their terminal exits, alongside the five most recent completed runs. The captured-output programming-language runner is removed: there is no request flag or fallback to select it. Compiler and interpreter commands both run directly in the terminal, with compiled binaries executed there only after a successful build. This changed run contract requires daemon/cockpit protocol 25.0; older clients and daemons must upgrade through the normal handshake. Text/notebook previews remain capped at the existing 5 MiB editor limit. Compilation remains local/SSH-only; the connector allowlist is unchanged.

  `.ipynb` files open in a notebook view with a two-state notebook/JSON source toggle. Version 4 notebook cells render Markdown/maths, code/raw text and saved stream/error/plain-text, HTML and PNG/JPEG/GIF output; HTML is sanitised and ordinary script output does not execute; widget MIME output uses the isolated renderer described below. Cells can be edited, added, deleted and reordered using the same Monaco JSON model, local drafts, save registry and stale-file reconciliation as the source editor. Edits preserve metadata, unknown notebook/cell/output fields and existing execution results. Cell sources use Puddle-themed Monaco models with viewport-based editor mounting, double-click Markdown editing, command/control-Enter rendering and Shift/Alt-Enter navigation. Unmounted or loading editors retain readable source and measured cell height; focused editors stay mounted. Cell layout fits the full source synchronously, including wrapping and font/pane-size changes; vertical wheel gestures scroll the notebook while horizontal gestures can scroll unwrapped code. Reopening restores the reading cell and its offset; live layout uses native scroll anchoring rather than repeatedly restoring a percentage of document height. Searchable cell labels change the nbformat kind or the code highlighting language; languages use VS Code's cell metadata without changing the selected kernel. A left gutter separates execution counts from language labels. Cell insertion, duplication, splitting, merging, reordering and deletion share the JSON buffer's undo history. Invalid JSON, unsupported notebook versions and more than 2,000 cells show a source-repair message. Mobile uses the same inert renderer without editing. With notebook packages available in the selected environment (or host `jupyter-nbconvert` for a registered kernel), the play button executes all cells with the notebook's selected installed kernel and opens a separate `<name>.executed.ipynb`; it never overwrites the original notebook. Since protocol 24.6, a daemon-owned Jupyter manager retains one kernel per canonical notebook path across runs, panes, browser reconnects and the compilation service's idle-target sweep. Different notebooks have independent kernels; only explicit Restart/Shut Down, kernel failure or daemon shutdown ends their state. Interrupt cancels the current execution while retaining its variables. Dead kernels require an explicit restart and no interrupted run is replayed. At most 32 notebook controllers may be live; capacity errors ask the user to shut one down instead of silently evicting a kernel. Startup, switching and shutdown are serialised, bounded discovery yields to the daemon event loop, and parent-pipe EOF cleans up kernels after an unexpected daemon exit. A Python bridge in the selected Python environment (or the nbconvert executable's environment) uses Jupyter's public kernel/client APIs, with private temporary connection files, bounded messages/output, and no shell. Standard `jupyter-nbconvert`, `jupyter nbconvert`, and `python -m nbconvert` commands retain execution-preprocessor options; commands must keep the notebook source, notebook output format, and managed output placeholders. The compilation endpoint retains this separate-result contract. Since protocol 25.2, the notebook editor instead submits bounded source snapshots to POST `/api/notebooks/execute`, observes POST `/execution`, and answers exact run/prompt requests through POST `/input`. Runs use the same canonical kernel and busy/lifecycle guards; code cells execute in document order and stop at the first failure or interruption. The bridge publishes throttled nbclient output snapshots, including display updates, with a 2 MiB output bound; requests contain at most 2,000 cells and 1 MiB of source inside a 2 MiB HTTP body. Latest results remain bounded by the existing kernel-entry capacity. Reconnect only observes; it never repeats execution. Input replies expire with their exact run/prompt. Prompts appear as plain monospace input lines inside the running cell’s output, expanding collapsed output and folded heading sections even before stdout arrives. Enter submits once per pending reply; each new prompt resets and focuses its input, passwords remain masked, and failed replies retain the value for an explicit retry. Accepted prompts and replies become standard stdout stream outputs in their cell, ordered with other results and retained through ordinary saving and reopening. Password replies use a fixed mask; rejected or unsubmitted values are never recorded. Traces share the output bound and clear-output/rerun behaviour. Ctrl+C interrupts when no input text is selected; native copying remains available. This uses Jupyter stdin messages, not a PTY or a terminal emulator. Widget MIME output takes precedence over its plain-text fallback; missing state or an older host shows a specific recovery message. Results merge by stable cell id into the shared draft, preserve newer source edits, and never recreate deleted/converted cells. Saved per-cell result revisions preserve deliberate output clearing on reopen. The header and open-tab play action share interactive execution; the overflow menu retains **Run to Executed Copy**. Cell controls offer Run Cell, Run Above (exclusive) and Run Cell and Below (inclusive); command/control-Enter executes the current code cell, Shift-Enter selects below, and Alt-Enter inserts below. Command/control-click on cell chrome runs that cell while Monaco retains its native navigation gesture. Missing kernels/packages surface Jupyter's error output. Creating a new empty `.ipynb` from the file tree or saving a blank untitled draft as one writes a version 4.5 notebook with empty cells and metadata. Existing file saves and non-empty new contents remain literal, including invalid JSON. Result tabs do not offer recursive execution.

  The notebook header contains **Code**, **Markdown**, **Run All**, **Clear All Outputs**, **Outline** and an overflow action for raw cells. Adding a cell reveals and focuses it; clearing output preserves source and metadata and participates in the normal editor save/undo flow. Outline entries reveal their cells without changing source. A host-kernel selector updates the notebook's kernelspec metadata and explicitly starts that kernel; changing selection starts fresh. Kernel controls show idle/busy/dead status and offer **Interrupt**, **Restart kernel** and **Shut down kernel**. They are feature-detected at 24.6 and absent from read-only mobile previews. There is no Generate action. On hosts below 25.2, header Run All retains the compilation path, input saving, command defaults, diagnostics and managed-result opening. On newer hosts, **Run to Executed Copy** retains that path, while interactive execution runs the current draft with the selected kernel. Since protocol 25.1, the picker also offers Python environments independently of registered kernels: `.venv`/`venv` beside the notebook and towards its source root, active environments, bounded conventional Conda/Mamba prefixes and their `envs` directories, Conda's environment registry, and PATH Python. Users can enter an environment folder or executable, including `~` and paths relative to the notebook. Discovery is asynchronous, capped at 32 candidates with four concurrent probes, and package probes are cached for 30 seconds. Incomplete environments remain visible; selecting one keeps it stopped and offers **Install ipykernel**, **Install nbconvert**, or both. Only that explicit action invokes the selected interpreter's `-m pip install` with fixed missing package names, bounded time/output, and no shell; failure stays visible and never switches environments. Installation rechecks the displayed Python path against the current selection so another pane cannot redirect it. A private temporary kernelspec pins execution to the exact interpreter without registering or overwriting host kernelspecs. Selections last for the daemon lifetime per canonical notebook, survive shutdown/restart of that kernel, and keep host paths out of portable notebook metadata. Notebook controls remain available when no global nbconvert exists so users can select and prepare an environment. Kernel settings and execution remain local/SSH-only; the remote connector and profile-lease allowlists reject every `/api/notebooks` route.

  **Live notebook publication**: publish the initial cell states once, then serialise cells whose execution state, output or elapsed time may have changed. Shared display-ID and widget messages conservatively revisit all cells because nbclient can mutate earlier outputs. Keep the existing output batching, value deduplication, clear-output behaviour and batch cancellation.

  Notebook search uses the shared Find widget across cell sources, optionally including text outputs; replacement only changes source. Heading sections can be folded and run from the outline. Command-mode copy/cut/paste preserves cell content and metadata while minting new ids on paste; Monaco and prose selections retain their normal clipboard. Source/run metadata marks stale results without deleting them. Notebook Markdown shares authenticated image resolution and Mermaid rendering with ordinary Markdown, resolves raster attachments, and keeps sanitisation. Outputs offer copying, image downloads, collapse/expand and SVG/JSON fallbacks. Since 25.3, code editors request bounded kernel completion/inspection for an already idle kernel; typing never starts a kernel or executes a cell. Completion offsets count Unicode codepoints, and stale replies are discarded. Assistance clients use distinct routing identities from execution clients and are time-bounded.

  **Jupyter widgets** (protocol 25.4). Each canonical notebook kernel owns a separate Jupyter client with its own routing identity and a continuous IOPub subscriber. It retains widget comm state, nested model references and binary buffers across cell runs, and owns Output capture even while no cell executes. POST `/api/notebooks/widgets` returns either an initial/resynchronisation snapshot in Jupyter widget-state v2 format or events after a cursor. State is capped at 1,024 models and 4 MiB; the event history retains at most 256 events and 2 MiB. Overflow is explicit and does not silently replay callbacks. POST `/api/notebooks/widgets/comm` accepts only widget comm open/message/close operations under the exact current kernel generation; shutdown, restart, environment switching and failed channels invalidate old writes. These operations reuse the existing local/SSH authority and remain denied to remote profile leases and the connector. No Jupyter server, new public kernel socket, or browser credential is exposed. The official Jupyter HTML widget manager renders core controls, layout/style models, linked controls, Output widgets and binary traits inside an opaque-origin iframe. Widget labels, HTMLMath and Output Markdown/maths use the shared Puddle renderers. Core JavaScript, styles and fonts are bundled locally; compatible custom AMD widget modules load from jsDelivr using their declared npm module/version and standard `dist/index.js` entry point. Live views may load these extensions; opening a saved notebook requires an explicit extension-loading action. The frame receives only validated widget comms through a private MessagePort, never notebook execution APIs or cockpit credentials. Its script policy is separate from the cockpit and ordinary HTML outputs. Widget state and binary buffers merge into the standard notebook metadata through the shared draft/save path; a size warning preserves the live view if the notebook would exceed the editor save limit. Executed copies also contain widget metadata. Browser reconnect and event-history gaps rebuild the model graph without repeating actions; restart/shutdown invalidate old views. Saved state can render without starting a kernel, with an explicit disconnected label. Remote/mobile previews remain inert. Output capture includes stream/error/rich display output, deferred clearing, explicit output assignment and display-id updates between cell runs. This is a kernel frontend with widget support, not a Jupyter Server implementation or a host for arbitrary JupyterLab extensions; private module registries and Lab-only widget packages require additional integration. See `docs/reports/2026-10-25-jupyter-integration.md` for the audit and verified coverage.

  **Language defaults and per-file commands.** Protocol 17.3 exposes the provider's independent `on_demand` and `eager` command templates and accepts explicit overrides. A compilable file row or open source tab offers **Compilation Settings…**, a compact provider-named dialog with independent **When clicked** and **Upon file change** fields; the latter states honestly that enabling eager mode also performs one initial run. Settings → Editor exposes the same shared command form with a **Language** dropdown, including advertised languages whose tools are not installed. Protocol 24.4 adds profile-wide defaults keyed by `(profile, provider, mode)` in `compilation_defaults`; they need no open file or project. File fields start with their explicit override, then the inherited language default, then the currently discovered source-aware provider default. Language fields start with the saved default or discovered provider command. Only providers advertising eager support show **Upon file change**. Save stores changed fields, while **Use default** resets only that slot to its inherited default. Resetting a language default leaves file overrides intact; resetting a file override resumes inheritance. Untouched source-aware defaults retain provider-owned entry-point and engine selection. Overrides are durable SQLite rows keyed by `(profile, project, provider, file type, canonical absolute file path, mode)`: they follow neither a transient session nor a pane, never collide across same-relative-path roots, and work for rooted external files outside the worktree. A provider advertises the placeholders its templates accept. LaTeX exposes `{{source}}`, `{{output_dir}}`, and `{{job_name}}`, and requires the managed output placeholder so a custom command cannot move generated/intermediate files out of the source root's local `.puddle`. The setting changes what the corresponding play/lightning execution runs; it does not change a tab's current eager/on-demand mode. Clients below 17.3 simply omit the menu item; newer clients hide language defaults until the host advertises protocol 24.4. Both defaults and file overrides remain local/SSH-only, outside the remote connector allowlist.

  Every LaTeX run and output stays below the selected source root's local `.puddle/latex/<document-hash>/`: a fresh `runs/<id>` holds intermediate output, while only a successful run promotes the PDF, SyncTeX index, log, and manifest to a stable current file root. No LaTeX artefact is written to the daemon's global `PUDDLE_HOME` or beside authored source files. A failed build leaves the last good PDF intact. The daemon retains bounded compiler output and normalises standard `file:line` plus classic TeX `! …` / `l.N` failures into rooted diagnostics. Manual and eager failures display an expandable compiler-output notification; diagnostics mark the corresponding Monaco lines, including included TeX files, and a later successful build clears that source's markers. Success invalidates that PDF's media bytes and opens it as an ordinary permanent `external` file tab in the invoked source pane. Eager delivery deduplicates by the successful result's own revision, not the status revision: running and failed statuses retain the previous result, so observing a new attempt must neither reload old bytes nor suppress the refresh when that attempt succeeds. A newly observed successful result is still delivered if a later run has already started. The whole live layout is checked first: an already-open rooted PDF is refreshed and focused rather than duplicated. Eager success performs the same refresh/deduplication but opens a missing PDF in the source pane's background without changing active pane, tab, or focus. The tab carries optional `generated_by` metadata across layout restore; all PDF tabs lazily load the locally bundled PDF.js viewer and worker, with inverse source navigation enabled only for generated LaTeX output.

  PDF pages expose a transparent PDF.js text layer over the rendered canvas, allowing native text selection and copying within and across pages. Text geometry follows zoom, pane resizing, page rotation and PDF user units independently of the canvas pixel budget; zoom reuses the text nodes, while refreshed documents discard the old text layer. Text extraction remains deferred until a page nears the scrollport, and a text-layer failure leaves the rendered page visible. Image-only PDFs require an existing text layer to support copying; the preview does not perform OCR.

  The PDF viewer starts fitted to the pane width and offers a minimal − / percentage / + overlay from 50–300% of that fit; the percentage resets to fit width and the buttons use deliberate stops. Trackpad and two-touch pinch gestures scale fractionally within the same bounds and keep the page point under the pointer or touch midpoint anchored after React commits the new page geometry, including on later pages with unequal sizes and fixed gaps, while ordinary two-axis scrolling remains unchanged. Larger pages scroll horizontally, and a bounded canvas-pixel budget prevents HiDPI zoom from allocating unbounded memory. Command/Ctrl-clicking a generated PDF page, including its selectable text, converts its displayed page point to 72-dpi PDF coordinates at every zoom level and calls inverse SyncTeX. The daemon accepts only a PDF matching its own managed manifest and SyncTeX index, invokes the discovered `synctex` binary without a shell, canonicalises the first result, and rejects a source outside the original Puddle file root. The web globally reuses or opens that ordinary rooted source tab, moves Monaco to the returned one-based line/optional column, and focuses it. Inverse search may land in an included TeX file rather than the main document. A normal PDF never acquires source-navigation behaviour. Each PDF tab retains vertical/horizontal scroll progress and zoom in bounded browser-window memory, scoped by transport, profile/project layout, pane and rooted file identity. Tab/project switches and refreshed PDF bytes restore that state after all page dimensions are available; loading placeholders and hidden zero-sized panes cannot overwrite it. Reloading the browser starts fresh; no viewport state travels through the daemon protocol.

- **Tab sizing** follows content across every kind: the shared 7.2rem floor leaves room for Resume, Archive and Close alongside a clickable title, while `max-w-52` caps long labels. Controls overlay the title without changing the chip's width on hover. A file label's marquee padding is cancelled out of its intrinsic width by an equal negative margin, but remains inside its measured scroll width so the revealed tail still clears the overlaid controls.
- **Markdown/HTML preview**: a `file` or rooted `external` tab whose path is markdown (`.md`/`.markdown`/`.mdown`) or HTML (`.html`/`.htm`) grows a **four-mode view toggle on its tab chip**, cycling **source → preview → linked → locked → source**. The current-mode glyph is file-code, eye, chain, or lock respectively; its tooltip names the next mode. The toggle and close × remain hover overlays that reserve no resting width and never resize neighbouring chips; the filename keeps its constant-speed marquee and the dirty dot stays in flow. The tab tooltip opens downwards and shows the full name, then the owning project/branch and agent/account where those identities apply; a terminal tab instead shows the terminal glyph and `terminal` type. The left navigator's worktree-choice dropdown uses this same stacked session presentation instead of flattening branch and name onto one line. The optional `view` persists in `ui_state.layout_tree` (`linked` since protocol 15.0, `locked` since 16.0); source/preview rewrite one tab in place and in that pane only.

  **Following modes.** `linked` and `locked` are distinct stable slots whose `(session, path[, root])` retargets to the most recently active renderable `file`/`external` tab in the live layout scope. Activations include chip and pane-body focus, navigator opens, drops, and the neighbour exposed by a close; neither following slot retargets from another follower. All following slots retarget together while preserving their own mode. Their constant `linked`/`locked` keys do not include the target, so retargeting moves no leaf pointers or React keys and does not dirty `layoutSignature`; one pane can hold one of each beside the ordinary target file. Entering, leaving, or crossing following modes remaps `activeKey`/`previewKey`, dissolving into an existing owner on collision. A follower in the ephemeral preview position is protected from replacement. Scope is project-local under `projectBasedLayout` and profile-wide otherwise; without an eligible driver followers keep their last target. Both read the target's shared buffer, including unsaved source edits, and live-poll clean buffers for agent-written disk changes.

  **Locked scroll following** (source-aware since 2026-08-27) aligns by a semantic, one-based source-line coordinate rather than treating unlike documents as equal-height scrollbars. The active renderable source, ordinary preview, or locked preview with transient **scroll ownership** is the sole driver; linked views never publish. Scroll ownership normally follows logical pane activation, but a wheel/trackpad gesture over another eligible surface transfers only scroll ownership — it does **not** focus that pane, change the sidebar binding, or redirect the next opened tab. Monaco derives a fractional source line from its public, wrap-aware line-top geometry; Markdown measures the live geometry of the block elements annotated from markdown-it token maps; authored HTML elements carry parse5 source locations into the sandbox, whose bridge measures them after authored CSS/scripts/layout. Each receiver piecewise-interpolates that source line through its OWN current geometry, so wrapped prose, tall media, headings, lists, fonts, and iframe reflow stay aligned. A clamped scroll ratio travels beside the line as the exact beginning/end signal and the fallback for a missing or script-invalidated map. Publications remain animation-frame-coalesced; receiving surfaces reapply after content, viewport, resize, or HTML mutation reflow and never feed back. Focusing a receiving source or locked surface promotes it to the driver before user scrolling. Positions and scroll ownership are transient, target-qualified browser state: a retarget subscribes before applying, an unseen target waits for its own driver, and a rooted external file never shares a position with a same-path worktree file. Reload starts empty and multiple browser windows never cross-talk.

  **Preview → source navigation.** Ctrl/⌘-clicking rendered content in a `linked` or `locked` Markdown/HTML preview inverse-interpolates the clicked rendered height to a source line, focuses the ordinary tab that most recently drove that follower, switches that tab from an ordinary preview to source when necessary, and moves Monaco's caret there. If that ordinary tab has since closed, it is recreated in its associated pane. The association is transient and root-aware: an external file returns to the same `(session, path, root)`, never a same-relative-path worktree file. An actual Markdown/HTML anchor keeps its existing link behaviour instead of being mistaken for a source reveal.

  **Rendering and security.** Desktop rendered modes use `useEditorBuffer` passively (one shared model and saver, no duplicate drafts/announcements) and follow the editor font size. The text renderers are independent of Monaco and reused by mobile remote Files with its fetched, read-only text. Markdown is `markdown-it` GFM with task lists, one- or two-tilde strikethrough, GitHub-style bracket-reference footnotes and `NOTE`/`TIP`/`IMPORTANT`/`WARNING`/`CAUTION` alerts, plus `==highlights==`; it is sanitised through DOMPurify, renders inline, resolves images — both ordinary `src` and responsive/theme-aware `srcset` candidates — through authenticated media fetches/object URLs, and opens worktree links on ctrl/⌘-click. Footnote reference/back-reference navigation stays scoped to its own mounted preview, so duplicate note ids across panes cannot jump between documents. A ` ```mermaid ` fence lazy-loads Mermaid and replaces its escaped source placeholder with a token-themed SVG; render jobs are serialised around Mermaid's global state, rerun on theme changes, keep strict security with diagram-side theme/security overrides disabled, and leave the source plus a concise error when parsing fails. HTML stays in an iframe sandboxed as `allow-scripts` **without** `allow-same-origin`; parse5's source-location pass adds inert line attributes before the existing DOM/asset pass, and assets, including image `srcset` candidates, are baked into `srcdoc` as data URIs (20 MiB each; nested stylesheet/script imports are not chased). Locked HTML keeps that boundary: a generated per-mount UUID bridge reports/applies only finite ratios and source lines through `postMessage`, the parent accepts only the exact iframe window/kind/channel, and neither the daemon token nor any authenticated capability enters the document. Internal load/`ResizeObserver`/`MutationObserver` reports reapply the latest locked position after delayed or script-driven reflow; a document that removes/corrupts its own inert anchors falls back to ratio alignment.
  - **LaTeX** in both views: `$…$` and `\(…\)` inline, `$$…$$`, `\[…\]` and ` ```math ` fences as display, typeset by **KaTeX**. KaTeX rather than MathJax because it is synchronous and layout-free — a preview re-renders on every keystroke of the shared model, and, decisively, the HTML document's maths is typeset **here, in the parent, before serialisation**: a null-origin iframe can never be handed a typesetter that reaches back. `$…$` follows pandoc's rules (no whitespace just inside the delimiters, no digit straight after the closing `$`), so prose currency — `$5 or $10`, `$5-$7` — stays prose; maths inside code spans, fences, or `<pre>`/`<code>` is never touched, and an HTML document that ships its own MathJax/KaTeX is left to it. Macros (`\gdef`, `\newcommand`) persist across one document, never between documents. Output is KaTeX **HTML wrapped in `role="math"` labelled with the TeX source**, not MathML: DOMPurify strikes `<semantics>`/`<annotation>` out by design, and the sanitiser guarding the origin that holds the daemon token is not worth widening for it. `trust` is off, so `\href`/`\includegraphics` in a worktree document cannot mint a URL (the HTML preview has no sanitiser at all), and a malformed expression renders in place, in `--danger`, with the parse error as its tooltip. The iframe gets the KaTeX stylesheet with its **woff2 faces baked in as data URIs** — a cross-origin font would need CORS the null origin will never get — loaded on demand, so only a document that actually holds maths pays the ~400 KB.

- **Navigators keep what they are showing while they re-bind** (decision 2026-08-04): the sidebar's worktree queries (tree, git status, uncommitted diff, log) hold their previous answer until the next one lands, and Changes/Search remount on the bound **worktree path**, not the session id — so switching between sessions that share a worktree, which is the default arrangement, changes nothing on screen instead of dropping every panel to "Loading…" and rebuilding it. A genuinely different directory still remounts them (an honest reload beats briefly showing another repository's history as if it were this one's).
- **Changes navigator** (repository-aware source control + history, protocol 15.3): two stacked panels over the visible directory, the **border between them draggable** (the source-control list is sized, History takes the rest; per-browser `localStorage`, capped against the sidebar height, `components/resizable-height.tsx`). The top lists one collapsible panel per repository, with the deepest repository owning the visible directory first, then ignored nested repositories and initialised or uninitialised recursive submodules; extra breathing room and a static divider separate adjacent repositories. Each repository name and muted relative worktree path form one continuous mixed-style line and hover marquee, so the full, stronger repository name gets the width first and the path follows it instead of competing in a second clipping region. The branch/detached state, upstream, and ahead/behind information then use their own full-width status line. Disclosure chevrons sit in the left gutter; gold change-group headings, directory chevrons, and file-status letters share the commit control's left inset, making the hierarchy's two levels explicit. An initialised panel shows a commit-message field (⌘/Ctrl+Enter), followed by compact square Fetch, Pull, and Push or Publish Branch actions beside a Commit button that fills the remaining row, and `Merge Changes`, `Staged Changes`, and `Changes` groups with per-file/group Stage or Unstage controls. Those groups default to compact directory trees and share a per-repository flat-list toggle; every directory row stages or unstages all displayed descendants (both literal paths of a rename included), while the group action still covers everything. Clipped repository headings, branch/upstream/status lines, and changed paths use the same constant-speed hover marquee as History rows. Commits consume the index only; with an empty index the UI asks before sending one lock-scoped stage-all-and-commit operation. Failure keeps the message, success clears it. Uninitialised submodules are disabled; a submodule commit leaves its parent's changed gitlink for a separate commit. The bottom remains the interactive commit graph, bound to the last-selected repository. Graph lanes continue through each row independently of parent connectors, including when a merge joins an existing lane; expanded file rows carry the outgoing lanes straight through. A client connected to a pre-15.3 daemon feature-detects the minor and retains the former read-only uncommitted list.
  - **Diff tab** (opened from source control): staged files show a read-only HEAD→index Monaco diff; unstaged files show index→working tree, with the modified side bound to the same shared model as that file's editor tab so edits and ⌘S use the conflict-safe save path. Added and deleted files select the meaningful single side. The session-vs-base diff mode remains unchanged.
    **Dirty-diff lifetime.** Ordinary-editor hidden diff controllers and their peek widgets detach during layout-effect cleanup, before passive shared-buffer disposal. Responsive workspace remounts must not dispose a model while a diff widget still owns it; the standalone preview browser check exercises repeated wide/narrow transitions.

- **Ordinary-editor dirty diff** (protocol 15.3): every editable text model is compared with the file at the deepest owning repository's current `HEAD`. A symlinked editor follows its resolved target for this lookup, matching the file route: Git's blob for the link itself contains only the target path and is not a content baseline; a target outside any discovered repository shows no gutter. A tiny hidden Monaco `DiffEditor` supplies `onDidUpdateDiff`/`getLineChanges`; no Monaco internals and no second diff implementation are used. The visible editor owns one decoration collection: green line-decoration bars for additions, blue bars for paired replacement lines (surplus inserted lines stay green), and red triangles immediately above deletion points, including beginning/end-of-file placements and surplus deletions. The line-decoration lane reserves width without enabling glyph margin; its markers sit four pixels after the line-number area (twice the original breathing room) while the lane keeps its width, so source text does not move. Clicking any marker inserts one read-only, unified **inline hunk viewer** through Monaco's public view-zone and standalone-diff APIs, sharing the same HEAD/live models and collapsing unchanged context; another marker replaces it, the × or a second click closes it, and removing the hunk by editing closes it automatically. It is informational only — no hunk stage/revert actions. Because the live model is the modified side, typing, undo/redo, and disk reloads update both marker and open peek immediately; baseline polling and Git-mutation invalidation cover commits, pulls, branch movement, and status refreshes. Untracked and unborn-repository text is wholly added; ignored, outside-Git, binary, and over-limit files show nothing. Both diff controllers, the HEAD model, listeners, view zone, and decorations are disposed with the source editor. Full diff tabs remain the review surface.
- **Search navigator**: filename + content search over the bound worktree in one query (Obsidian-style) — a "Files" section (path matches, subsequence-ranked) and a "Contents" section (per-file line matches from `git grep`, match-highlighted), with case / whole-word / regex toggles (regex is PCRE, matching the client's JS-regex highlighter). Untracked-not-ignored files are included, mirroring the explorer. Clicking a filename (a path match or a Contents file heading) opens the file and switches to Files, expanding its ancestors, selecting it and scrolling it into view. Clicking a per-line content match opens it at that line while keeping Search visible; its tree reveal waits until Files is shown. The query is debounced; results are capped server-side with a "showing the first results" note when truncated.
- **Worktrees navigator**: a repo-wide manager (not bound to the pin) over `GET /api/repos/:id/worktrees`, which returns every git worktree grouped by branch plus the local branches that have **no** worktree (`orphan_branches`). Each worktree is tagged with its state — the **clone** (primary), **uncommitted** (dirty), and a **running** session count. Two destructive actions, both guarded by the daemon and mirrored in the UI (disabled control + tooltip):
  - **Prune a worktree** (`DELETE /api/repos/:id/worktrees?path=`) removes its directory — the branch is always kept, so there is no data-loss prompt. Refused for the clone (`worktree_primary`), a dirty worktree (`worktree_dirty`), or one a live session is using (`worktree_busy`).
  - **Delete an orphaned branch** (`DELETE /api/repos/:id/branches?name=&confirm=`) — only branches with no worktree (`branch_in_use` otherwise; a branch with a worktree must be pruned first, and git won't delete a checked-out branch anyway). A **local-only** branch (commits on no remote) needs `confirm` (`branch_unpushed`), since deleting it discards those commits — the confirm dialog warns.
- **File transfer** (client ⇄ worktree): dragging files — or whole folders — from the OS onto the file explorer uploads them into the hovered folder of the bound worktree (`POST /upload`; multiple entries per drop, path-contained to the worktree, size-capped). A dropped folder is walked in the browser (`webkitGetAsEntry`) and each descendant travels as a multipart file named with its relative path, which the daemon rebuilds — empty directories are skipped; on a pre-9.2 daemon (which would flatten the paths) folders are rejected with a toast, feature-detected via `GET /api/version`. Pasting copied files into the explorer uploads the same way, targeting the focused folder (or a focused file's parent); a clipboard image such as a screenshot is named `Screenshot YYYY-MM-DD at HH.MM.SS.mmm.png` from the client's local paste time, with a numbered suffix when one paste contains several images, while non-image files retain their real names. Native clipboard files win over the explorer's persistent cut/copy clipboard for that paste gesture. Every explorer context menu offers **Download** (`GET /download` — a single file streams as-is, a folder arrives as a zip built on the host; a multi-selection downloads each entry in turn) alongside the file operations above. Remote→local drag-out is not portable across browsers (Chromium-only `DownloadURL`), so the download action is the v1 mechanism; drag-out can be layered on later as a progressive nicety. Everything rides the normal authenticated API through the tunnel, so local and SSH modes behave identically.
- **Commit tab** (opened from the Changes graph): the `sha^ → sha` diff of one file, read-only. Unlike the diff tab it never touches the shared editor buffer — both sides are private Monaco models created and disposed with the tab, and the root commit's files render as `added` rather than fetching a nonexistent parent. Covers "tap into the worktree and see git histories."

## 9. Ports

- **Detection**: listening ports owned by the session's process tree — `ss -tlnp` on Linux, `lsof -iTCP -sTCP:LISTEN` on macOS (the daemon picks per platform).
- **Local mode**: ports are directly reachable; the table shows plain `http://localhost:<port>` links, no forwarding needed.
- **SSH mode, tier 1 (Phase 5)**: the table shows a copyable `ssh -L <port>:127.0.0.1:<port> user@host` command per port.
- **SSH mode, tier 2 (live, Phase 5)**: `/proxy/:sid/:port/` streams HTTP and WebSockets through the tunnel, gated by the detected ports of that placement and protocol-18 authority (§2). Links use the trusted `/forward/:sid/:port` landing page, then the isolated `127.0.0.1` application origin. Request paths retain their original encoding, `Host` becomes `127.0.0.1:<port>`, and hop-by-hop headers plus all Puddle credentials are stripped. Application Authorization headers, other cookies, response headers and query parameters pass through. Unknown ports trigger one immediate rescan before rejection; connection/first-byte failures return 502, while application responses retain their own status. **UI**: a session's ports render as a slim strip IN FLOW at the bottom of ITS OWN pane — below the terminal, which shrinks to make room; deliberately not an overlay, so nothing ever sits over the terminal (the old placement at the bottom of the whole workspace read as global and detached from its session; the pane's Resume button IS a small bottom-right overlay, being transient). Captured environment names share this metadata area; its top and bottom breathing room are equal, and when both rows appear their gap is exactly that same single spacing unit. Shown by whichever pane's active tab is that session's terminal; the strip polls `GET .../ports` every 5s per SHOWN live session — no manual refresh, the interval is the refresh. Each port is a chip offering the access paths that fit the window's mode (the CLI's `?host=` boot param is the signal): the localhost link in local mode, the proxy link in SSH mode, and a copyable `ssh -L` always.

Applications share the separate `127.0.0.1` origin and are not isolated from each other; none shares the cockpit's `localhost` localStorage. Absolute paths escaping a proxy prefix are recovered only from a same-application-origin Referer, using a 307 redirect into that target's prefix. The cockpit origin never serves application content. WebSocket handshakes and apps using `Referrer-Policy: no-referrer` cannot use Referer recovery; the explicit proxy path or copied `ssh -L` command remains available. Missing static assets with file extensions return 404 instead of the SPA index.

Each env/ports value list is one non-wrapping line. When it exceeds the pane width, only the values scroll horizontally, with the scrollbar hidden and the `env`/`ports` label fixed.

## 10. `puddle` CLI (client)

The same npm package and standalone archives ship `pudl` for puddlang: run, context,
status, logs, cancel, outcomes, outcome and mcp commands. They reuse local/SSH
authority and require an existing daemon with the current application major
(26.x); outcome inspection/disposition requires 26.1. One selected profile binds
each connection.
Run waits by default (`--detach` returns after submission); observer exit does
not cancel work. Stdio MCP exposes the same service. HTTP MCP, automatic agent
binding and inherited descendant budgets are deferred. Both launchers upgrade
and remove with the CLI; desktop-only installs need the CLI for these commands.
See [usage](docs/puddlang.md).

```
puddle launch  [local | user@host] [--port <p>] [--remote-port <p>] [--foreground] [--no-browser]
                                       # one verb, both modes: no target (or 'local') ensures puddled on
                                       # THIS machine and opens the UI; user@host is SSH mode over one tunnel
puddle refresh [local | user@host]     # stop the target's cockpit and run the launch flow again (same UI port)
puddle list                            # running cockpit processes on this client
puddle kill    [local | user@host | --all]   # stop a cockpit (attached-daemon state stays resumable)
puddle status  [user@host]
puddle attach  [user@host] <session>   # raw-terminal attach over the WS
puddle install <daemon|runtime|desktop>[@version] [user@host] [--tarball <path>]
puddle upgrade [cli|daemon|runtime|desktop][@version] [user@host] [--tarball <path>]   # no component: everything installed, CLI last
puddle updates [user@host] [--operation <id>] [--cancel] # cancellation requires an exact id before dispatch
puddle remove  <cli|daemon|desktop> [user@host] [--yes] [--purge] [--stop-runtimes] # confirmations default to no
puddle logs    [user@host] [session]
```

Log viewing streams stdout without retaining a duplicate copy in the local or SSH transport; diagnostics retain only the final 64K UTF-16 code units of stderr. Other command execution keeps full output capture by default, including callers that also receive progress callbacks.

`launch` with no target (local mode; decision 2026-07-28 unifying the former `start`/`connect` verbs): install/upgrade the daemon under `~/.puddle/bin`, ensure the systemd user unit (same as remote), run the protocol handshake (§6), serve the UI at `http://localhost:7433` with `/api` + `/ws` proxied to the daemon on `127.0.0.1:7434`, open the browser. No SSH, no tunnel — but the same serve/proxy path as remote mode. `status`/`attach`/`logs`/`upgrade daemon` default to the local daemon when no host is given.

**Component management** (`install` / `upgrade` / `remove`, decision 2026-08-07, superseding 2026-07-28's subject-only `upgrade`): the components are `cli` (standalone or npm-distributed), `daemon` (the ~/.puddle host bootstrap), `runtime` (the default `puddler` build on that host), and `desktop` (the macOS app bundle; on Linux `install desktop` ASKS where the AppImage should live — default `~/puddle`, `ask()` taking the default without a TTY — placing it under the stable name `Puddle.AppImage` so launchers and the in-app updater keep a fixed path, then opens the directory in the file manager (best-effort `xdg-open`); upgrades stay in-app — the running app knows its own `$APPIMAGE` — and remove declines, naming the default location). Every verb takes an optional `@version` (`daemon@v0.0.32`, the `v` optional) and an optional `user@host` — `cli` and `desktop` refuse a remote target rather than half-support package-manager or app-bundle surgery over non-interactive ssh. **install** ensures presence: already installed with no `@version` → a no-op that says so; a named version installs exactly that (downgrades included — naming a version is the point). **upgrade** moves to the newest release (daemon/desktop lookup uses the GitHub API, standalone CLI uses the GitHub latest-release redirect, and npm CLI uses the npm registry; daemon/runtime discovery uses the release manifest and fails without selecting a substitute when unavailable) or the named one, installing a missing component — `upgrade desktop` ≡ `install desktop` when absent; with **no component it covers everything installed on the target** (a remote target ⇒ its daemon and installed runtime default), the **CLI strictly last** since it replaces its own installation; standalone `cli` runs its embedded `install-cli.sh` with the existing prefix and launcher directory, while npm installations use `npm install -g @puddle-code/cli@<version|latest>` under the hood. An explicit daemon `@version` that differs from the CLI's own prints the **pin warning**: across an older daemon protocol major the next `launch` offers to upgrade the daemon back after confirmation (§6), so the version must be pinned as a set (`upgrade cli@vX` too) or launched `--no-upgrade`. **remove** uninstalls after a y/N confirmation that defaults to NO (`--yes` for non-interactive use): `cli` removes its recognised standalone installation and exact owned launcher, or an npm global install (a repo checkout is removed the way it arrived); standalone removal advises closing cockpits first and leaves daemon installations/data untouched; `desktop` deletes the closed app bundle plus the staged-update cache (recent-hosts kept); `daemon` uses coordinated host removal on persistent-runtime installations. It disables remote access, stops daemon-owned work and reviews whether to retain or stop independent runtimes. Retention is the default; stopping requires separate interactive approval or `--stop-runtimes`. Data, referenced builds and saved service definitions survive, and deliberate `install daemon` restores a completed removal. An unfinished removal or purge must be resolved first. `--purge` separately authorises reviewed managed-data deletion with runtime-stop consent, fresh dirty/unpushed worktree checks and the verified reboot barrier; permanent control/recovery anchors remain. Legacy installations retain their existing data-preserving removal path. Local and SSH targets share these helpers without requiring sudo.

Runtime removal is part of coordinated daemon removal, followed by reference-aware
collection of eligible software. There is no standalone `remove runtime` command
or backend-disable option. Retaining a runtime retains its launch records and
pinned executable/helper trees; stopping it does not authorise deleting other
runtime references or native conversation data.

`puddle --version` inventories the local component slots without contacting a release service: the running CLI's compiled version/protocol, the bootstrap-managed daemon's plain `VERSION`/`PROTOCOL` release metadata (with a legacy fixed-version symlink fallback), the desktop installation record, and the runtime default selected by `runtime-current` with its separate `RUNTIME_PROTOCOL`. Runtime install/upgrade requires a running 25.7+ host and an available user service manager; local archives require an explicit version and verified checksum. Bare CLI upgrades select host components sequentially; cockpit preparation can select daemon and runtime software together through the combined host transaction. The desktop installer records a chosen AppImage path immediately, while every packaged desktop refreshes that record with its exact self-reported version/protocol at launch; macOS also falls back to its conventional Applications locations. Missing components say `not installed`, and legacy official releases fall back to the immutable version-to-protocol ledger rather than executing a possibly pre-Phase-6 daemon whose `--version` flag could start it.

The UI server picks `7433` by default and auto-picks the next free port when it is taken (e.g. a second `puddle launch` to a different host); the chosen origin is printed and opened. Whether one CLI process can multiplex several hosts behind a single origin is an open question (§15) — v1 is one CLI process, one host, one origin.

### Remote connector commands

`puddle remote enable --profile <profile-id> [user@host] --service <https-origin> --app-origin <https-origin>` reads a five-minute registration code from hidden stdin, stores host-only routing state and installs the connector under systemd/launchd. Existing registration can be re-enabled without origins. `--foreground` selects an operator-managed persistent supervisor; `remote run` supervises all profile registrations without backgrounding. `remote status|pair|devices|disable --profile <profile-id> [user@host]` and `remote approve|revoke <id> --profile <profile-id> [user@host]` use private host IPC (offline status/disable/revoke remain available). Pair prints an invitation only to the explicit foreground caller. `remote reset --profile <profile-id> [user@host]` is local/SSH-only: disable, revoke the selected profile’s browsers and rotate its identity before fresh pairing. No remote key reset or silent recovery enrolment exists.

The daemon tarball includes `puddle-connector` and `daemon/connector.mjs`, sharing its pinned Node/native runtime. Upgrading restarts an existing supervised connector; removing the daemon persists remote disable and removes both supervisors. Self-hosted service and static app images, ingress configuration and operator environment examples live in `deploy/remote`; no machine execution state is mounted into those services. Runtime images explicitly make package metadata, configuration and public assets readable by their unprivileged users, independently of checkout permissions; deployment secrets remain excluded from the build context. The application serves port 8080 and removes Caddy's unused privileged-port file capability so it can start with all capabilities dropped. The service image creates `/data` at mode `0700`, owned by UID 10001; fresh Docker volumes inherit this metadata. CI validates the Compose configuration using a temporary mode-0600 copy of the example environment file, removed after validation, then verifies database startup with a fresh volume, restart with retained state, and static assets under the production container restrictions. The static application image installs only the web package and its dependencies; production builds use `vite.build.config.ts`, while the default `vite.config.ts` adds the CLI-backed authenticated development gateway. See [deployment](docs/mobile-access.md).

### Distribution and bootstrap

**Selective component releases (application 26.2).** Release tags remain one
version sequence; cockpit (CLI/web/desktop) publishes at every tag, while daemon
and runtime may retain their most recent published versions. The committed and
published `release-manifest.json` (format 1) names the tag and the three component
versions. References cannot point forward; asset locations derive from those
versions and the trusted repository. Host executables continue to share an archive
when either host component publishes; its embedded manifest prevents selection of
an unpublished component. A cockpit-only tag omits host archives entirely.
The manifest does not bypass protocol, checksum, admission or exact update approval.

`node scripts/plan-release.mjs --version X.Y.Z --base vA.B.C --components auto`
prepares the manifest before tagging. Automatic selection compares each host
component with its own last published tag using shipped bundle import closures,
with conservative shared dependency/build/helper handling. Version-only package
bumps and documentation do not require host publication. `--components all` or an
explicit comma-separated list overrides selection; cockpit is always included.
`--dry-run` prints the plan without changing it. Review and commit the manifest
with the release version/changelog. CI requires an exact version match and skips
host archive jobs' build/continuity/ABI steps when neither host component publishes.
Packaged continuity installs the manifest's published runtime before its daemon,
fetching retained component versions through the checksum-verifying installer
from the workflow repository (`PUDDLE_REPO` for local acceptance). It verifies
owner continuity and independent selector repairs with those actual versions.

The first manifest-aware release publishes all components. New readers accept
legacy releases without a manifest; an advertised manifest that fails validation
or retrieval is an error, never permission to fall back. Later selective releases
require clients to have crossed that transition. Existing installed owners keep
running; release-number skew alone never triggers replacement. Old strict catalogue
readers receive only the old shape; new fields require explicit opt-in and protocol
26.2 support. A legacy unified offer is suppressed on new hosts when components
have diverged. Explicit `daemon@X` or `runtime@X` requests fail if that component
was not published at X. Versionless discovery resolves each component separately,
not the global tag. Build-time pins come from the manifest, including offline
bootstrap defaults. Fresh network daemon bootstrap installs its accompanying
published runtime first when necessary, without replacing an existing runtime pin.
The embedded shell installer also reads bounded per-component version pointers;
legacy pointer absence retains the old all-components interpretation. Direct
bootstrap of a selective daemon without its required runtime refuses safely and
directs the caller to use an updated cockpit.

- **CI dependency installation**: CI and release jobs use `scripts/install-ci.mjs` for frozen-lockfile installs. It checks and selects the headers bundled with the running Node installation, so a failed native-addon prebuild download can fall back to compilation without downloading Node headers again. The override applies only to dependency installation; Electron packaging retains its own header selection and Linux releases retain their compiler and ABI settings.
- **npm publishing**: the `npm-publish` job in `.github/workflows/release.yml` publishes `@puddle-code/cli` after the GitHub release succeeds. It uses GitHub OIDC trusted publishing with job-scoped `id-token: write`, npm 11.21.0 (Node 22's bundled npm 10 lacks this support), public access and provenance; no `NPM_TOKEN` secret is consumed. In the npm package settings, add a GitHub trusted publisher whose owner and repository exactly match `packages/cli/package.json`'s `repository.url`, whose workflow filename is `release.yml`, whose environment is empty, and whose allowed actions include direct `npm publish`. Registering provenance alone does not grant publishing access. Configure the publisher before the next release; see [npm's trusted publishing instructions](https://docs.npmjs.com/trusted-publishers/).
- **npm recovery**: after correcting npm settings, retry only the failed npm job from a release that already contains the trusted-publishing workflow. Rerunning an older Actions run still uses its old workflow, including `NPM_TOKEN` authentication; workflow changes require a new release tag to take effect. Keep the checkout on the triggering tag, and require the CLI package version to match that tag before building. npm derives provenance source metadata from the triggering workflow ref and SHA, so a manual run on `main` must not silently check out and publish a different old tag. Existing npm versions are immutable; never move an existing release tag to repair its workflow.
- **Release artefact**: self-contained per-platform tarballs (`puddled-v<X.Y.Z>-<os>-<arch>.tar.gz`; currently linux-x64, linux-arm64, and darwin-arm64 — darwin-x64 is unpublished while GitHub's Intel runners queue too slowly to block releases on) published on GitHub Releases with a checksums file. Each contains a pinned Node runtime, the bundled daemon, prebuilt `node-pty` binaries, and plain `VERSION`/`PROTOCOL` metadata — no Node, npm, or compiler is assumed on the host; only libc and `git`, and `puddle --version` can inventory an offline daemon without starting it. Linux native modules are source-built inside a glibc 2.28 container (RHEL/Rocky 8 floor), rather than inheriting the hosted runner's newer ABI; node-gyp uses Rocky's Python 3.11 and GCC Toolset 14 for current Python/C++ syntax, with the toolset runtime linked statically. The release workflow inspects every staged `.node` file and rejects a glibc requirement above 2.28 or a dynamic GCC Toolset runtime before publishing. The web UI assets ship inside both CLI distributions (the command is `puddle`), so `puddle upgrade cli` refreshes the UI on the client through its original installation channel, touching no host.
- **Install location**: entirely under the home directory, never sudo: fresh immutable generations at `~/.puddle/bin/versions/<release>~<generation>/`, selected by `~/.puddle/bin/current`. The embedded installer reuses the standalone CLI installer's lock, staging and atomic symlink replacement pattern. Healthy selected or legacy fixed-version trees can be reused; failed validation and `--force` stage a fresh generation, preserving all published files. Failed staging leaves the selection intact. Old generations remain until reference-aware collection is implemented. A killed installer leaves a fail-closed lock for explicit recovery. Version discovery reads `VERSION` without executing a service. The production backend still interrupts/resumes sessions when its daemon restarts; the persistent-runtime coordinator, coordinated multi-component activation and migration-aware rollback remain under development. Removal follows the component/data confirmations above.
- **Standalone CLI distribution**: `puddle-cli-v<X.Y.Z>-<os>-<arch>.tar.gz` ships on the same release matrix as the daemon (linux-x64, linux-arm64, darwin-arm64). `scripts/build-cli-tarball.mjs` packages the existing CLI bundle, web assets, both embedded installers and host-control helper with the pinned runtime shared through `scripts/lib/node-runtime.mjs`. It needs no installed Node/npm; npm remains an optional channel. `scripts/install-cli.sh` verifies downloaded archives against release SHA256SUMS, smoke-tests the bundle before activation, and installs without sudo under `${XDG_DATA_HOME:-~/.local/share}/puddle/cli` (override `PUDDLE_CLI_HOME` or `--prefix`), with a wrapper in `~/.local/bin` (override `--bin-dir`). It prints PATH guidance and refuses to replace unrelated launchers. Installation metadata identifies the actual running script/runtime; extracted but unmanaged archives cannot accidentally upgrade/remove a separate npm installation. Installs are serialised by an installation lock and activate a fresh immutable tree through an atomic `current` symlink replacement. Old trees remain so running cockpits retain their assets, including same-version reinstalls; removal deletes the standalone tree after confirmation. `--version` pins upgrades/downgrades; local `--tarball` plus optional `--sums` supports offline tests (omitting local checksums emits a warning). CI exercises installation, inventory/help, explicit/latest upgrades, failure preservation and removal with neither Node nor npm on PATH. Its isolated PATH includes required system utilities (including gzip for GNU tar), invoked through wrappers at their original paths so macOS can locate its versioned Perl scripts.
- **Public installer**: the trusted app image and new GitHub releases publish only `/install.sh`, rendered from `scripts/install-cli.sh`, to install the CLI. Users install daemon and desktop components through `puddle install daemon [user@host]` and `puddle install desktop`; first local/SSH connections still bootstrap missing daemons automatically using the embedded `scripts/install.sh` and GitHub daemon archives. The internal daemon script is never published as an installer asset. `/install-cli.sh` and `/install-daemon.sh` are removed, and staging prunes old copies. Installer URLs never use the SPA HTML fallback; removed/missing URLs return 404. The public script uses `text/plain` and `Cache-Control: no-store`. `scripts/stage-installers.mjs` bakes the release repository from CLI package metadata or the app's optional `PUDDLE_REPO` build argument. Every app rebuild refreshes the script from that checkout; it resolves the latest release when run, so only installer/repository changes require an app rebuild. GitHub Releases still host the binary archives and SHA256SUMS; new CLI archives must be published before the online installer can fetch them. Desktop remains independent of an installed CLI at runtime, with its existing embedded daemon bootstrap and self-updater.

- **Bootstrap** (shared by local and SSH `launch`): detect platform (`uname -sm`), create a private `0700` Puddle home (or migrate an eligible legacy home as in §2) before writing install state, fetch the tarball — host-side `curl` from GitHub Releases (checksum-verified), falling back to `scp` from the CLI's cached copy for hosts without outbound internet — unpack, then install a supervisor:
  - Linux: systemd **user** unit `~/.config/systemd/user/puddled.service` (`Restart=always`), `systemctl --user enable --now`, plus `loginctl enable-linger $USER` for boot-start without login.
  - macOS: launchd agent `~/Library/LaunchAgents/dev.puddle.puddled.plist` with `KeepAlive`.
  - Neither available: nohup + pidfile fallback with a printed warning that reboot auto-start is not configured. The installer records its choice in `~/.puddle/supervisor`. During SSH launch, if the normal health probe fails, that marker says `nohup`, and the exact recorded PID is dead, the CLI starts `puddled` in a live SSH exec channel and owns it for the cockpit's lifetime. It never does this beside a live nohup child, systemd, or launchd daemon. Closing the cockpit sends SIGTERM to the daemon and waits for clean shutdown. Independent owners are detached; host-session runtimes may survive or may be stopped by the host’s SSH/login teardown policy. On the next launch surviving owners are adopted; ended owners reconcile to `interrupted` and auto-resume when the host setting is enabled (the default). SQLite, worktrees, logs, agent config and native session refs remain under `~/.puddle`. A recovered SSH connection re-establishes the attached daemon before declaring its tunnel restored.
  - **Agent PATH**: a supervisor gives the daemon a bare PATH (launchd's `/usr/bin:/bin:/usr/sbin:/sbin`), so both the systemd unit and the launchd plist set a PATH that includes the dirs agent CLIs install to — notably Claude Code's native-installer `~/.local/bin` — else the daemon cannot spawn `claude`. The daemon also prepends `config.json`'s `agentPath` (colon-separated, tilde-expanded; default `~/.local/bin:~/bin:/opt/homebrew/bin:/usr/local/bin`, editable in Settings → Sessions) to `process.env.PATH` at boot, so a custom install location works without touching the supervisor.
- **Explicit daemon installation**: `puddle install daemon [user@host]` invokes the same embedded bootstrap as first connection; there is no public daemon installation script.
- **Version handshake**: CLI and desktop share the host-control/inspection negotiation in §6. An older major asks for a daemon update before connection; `--no-upgrade` aborts before asking. A newer major refuses with client-update guidance, and a match proceeds silently regardless of app-version skew. The subsequent authenticated `GET /api/version` verifies the data path without a separate upgrader.

`launch user@host` (SSH mode) flow:

1. Open a **master SSH connection** with multiplexing (`-o ControlMaster=auto -o ControlPath=~/.puddle/cm-%C -o ControlPersist=10m`). (`%C` — a hash of the connection — keeps the control-socket path under the Unix ~104-byte cap however long `user@host` is; decision 2026-07-14.) In the CLI, the system `ssh` binary inherits the user's TTY; in the desktop app, it receives an `SSH_ASKPASS` executable backed by a dedicated modal. Password, key-passphrase, keyboard-interactive/2FA, and host-confirmation prompts therefore still come from `ssh` itself and are answered at most once per live master. The desktop bridge authenticates a loopback-only, one-process helper with a random token; secret responses travel dialogue → main-process memory → helper stdout → `ssh`, and are never logged or stored. Every subsequent exec and the tunnel reuse the master connection. Over the master: read the installed version from `~/.puddle/bin/current/VERSION`, falling back to `readlink ~/.puddle/bin/current` only for legacy fixed-version trees (never by executing an unknown `puddled` — a pre-Phase-6 binary would start a daemon on `--version`).
2. Over the authenticated SSH connection, bootstrap the daemon if needed, then open a dedicated bidirectional control channel to the bundled host helper. On older hosts, stage that helper with the installed Node runtime; legacy inspection reads the master only in the host process and returns validated version and upgrade-impact metadata. Use the shared handshake to ask about older protocols, honour `--no-upgrade`, reject newer protocols, and acquire fresh compatible authority after an approved upgrade.
3. Forward the daemon port advertised by host control, then verify the authenticated API version without a second upgrade decision. The connection-authority handle owns renewal and revocation independently of SSH process identity, debounced tunnel notifications, or an attached daemon’s process lifetime. On recovery, a changed host port rebuilds the forward and a fresh generation must handshake before data access reopens.
4. The tunnel keeps the connection actively alive (`ServerAliveInterval=15`, `ServerAliveCountMax=3` on every ssh spawn — idle NAT/firewall timeouts must not fell it). Its health is judged by the **forward**, not the spawned ssh client: over a multiplexed master a non-OpenSSH server (Tailscale SSH) installs the `-L` on the master and the client exits at once while the forward keeps carrying traffic — and killing that client does not remove the forward (only `ssh -O cancel` does). So readiness is the local listener accepting **plus** an end-to-end probe the daemon answers `/api/version` through (any HTTP status proves the byte path; the authenticated handshake follows), and liveness is a periodic check of that local listener. On loss the master is checked (re-opened if lapsed) and the forward respawned on the same local port; only if that port got stolen is a new one picked and the UI proxy repointed. A forward abandoned on the master is cancelled with `-O cancel` so it does not leak its port. (An earlier `ExitOnForwardFailure=yes` was dropped — those servers trip it even on a working forward.) The tunnel-down/tunnel-up events are announcements, not child-exit telemetry: an outage that heals inside a 2s grace window is silent, unless it follows a restore within 30s (flapping), which announces immediately.

### Cockpit lifecycle: background by default

`launch` runs the cockpit (UI server + tunnel) **in the background** once ready: the launching process bootstraps interactively (ssh auth prompts happen on its TTY, warming the control master), re-execs itself detached with stdio to `~/.puddle/logs/cockpit-<target>.log`, relays that log and any daemon-update confirmation to the terminal until the child reports ready (approval uses a private IPC pipe, closed after startup, and is never persisted), prints the URL, and exits — the terminal may close. `--foreground` keeps today's attached behaviour (Ctrl-C stops the cockpit). Either way the cockpit writes a record to `~/.puddle/cockpits/<target>.json` (`target` is `local` or the `user@host` argument; one cockpit per target — a second `launch` reports the running one instead of duplicating it) holding pid, origin, protected launcher IPC address, daemon lifetime, and a per-instance nonce the UI server echoes on every response as `X-Puddle-Cockpit`. `puddle list` and `puddle kill` trust a record only after verifying pid liveness AND that the recorded origin echoes the recorded nonce — identity, not reachability (the same discipline as the daemon-port probe). Only a dead pid is pruned; a live pid whose origin does not confirm (recycled pid, stranger on the port, cockpit too busy to answer) shows as `unverified` and is never auto-deleted — the record is the only handle to a possibly-live process, and `kill` still works on it. `kill` sends SIGTERM (the cockpit's clean-shutdown path; SIGKILL after 10s), stopping the UI server and tunnel. A persistent daemon and its sessions keep running; an SSH-attached daemon shuts down cleanly, and the CLI says explicitly that host data remains and interrupted sessions can resume on the next launch. Known residue: a detached **CLI** cockpit has no TTY or GUI askpass bridge, so if the control master lapses on a host that needs interactive auth (password/2FA), the tunnel's reconnect retries visibly in the cockpit log but cannot prompt — `--foreground` is the answer for such hosts, and the only CLI mode Windows (no ControlMaster) can re-authenticate in at all. The in-process desktop cockpit keeps its askpass bridge for reconnects.

Use the system `ssh` binary (spawned), not a JS SSH library: it inherits the user's `~/.ssh/config`, agents, jump hosts, password/2FA prompting, and MFA for free. If no key is set up, `launch` works over password auth via the master connection; print a one-line hint suggesting `ssh-copy-id` for a smoother experience.

### Refresh: replace a cockpit in one step

`puddle refresh [local | user@host]` (target defaulting to the sole running cockpit, as `kill` does) is kill-then-start as one command, for when a cockpit is wedged — an SSH drop the tunnel never recovered from, a stale unverified record, a daemon that stopped. It terminates the old cockpit whatever its state (running, starting, or unverified; a dead record is just pruned), then runs the full `launch` flow — bootstrap/restart the daemon if it is down, reopen the tunnel, handshake — accepting the same flags. The new cockpit **prefers the old UI port** (read from the record's origin; non-strict, unlike `--port`) so an open browser tab keeps its origin and can simply reload.

The same refresh is reachable **from the UI**: authenticated `POST /cockpit/refresh {refreshId}` is a cockpit-local endpoint, defined in `packages/shared` with the rest of the protocol. It persists browser authorisation before responding `202 {status:'refreshing', refreshId, instance}` and coalesces repeated requests. The CLI launches a detached replacement with invitation output suppressed; the desktop replaces its cockpit in-process. The connection banner and ⌘K “Refresh connection” share one controller: poll authenticated `/cockpit/status` until the matching refresh id belongs to a different instance whose daemon handshake is ready, then reload. An old instance, mismatched id, `401`, or recovering upstream is never readiness. Ordinary refresh preserves the origin and login. Desktop refresh preserves the route and obtains a fresh invitation if the port changes; the native menu explicitly reloads after replacement. Terminal attachments restore canonical snapshots; disconnected writes are rejected and queued work from an obsolete generation is discarded. Uncertain stdin or mutations are never automatically resent. Detached CLI refresh has no terminal for password/2FA or daemon-update approval; desktop askpass or `puddle refresh` in a terminal handles that case.

`GET/PUT /cockpit/local-sync` is the machine-shared settings store behind Settings → Remote & Sync (§11), backed by `~/.puddle/local-sync.json` on the client. It uses browser authorisation and exact cockpit Host/Origin checks, independently of upstream availability, as do `/cockpit/status` and `/cockpit/refresh`. Entries remain keyed by profile name, with read-merge-rename writes; embedded servers without a store answer 404 and hide the feature.

`GET/POST /cockpit/remote?profile=<profile_id>` (profile-scoped since protocol 22.0) powers **Settings → Remote & Sync** in browser, Electron and development cockpits, for the selected profile on the local/SSH host open in that window. Query caches and pending sign-in handoffs follow that profile; switching it discards the old handoff. GET projects connector availability, configuration, supervision, relay status, public origins/identity and device grants; it never returns host private keys, routing credentials or service-account tokens. POST validates the shared discriminated command schema and dispatches enable, pair, devices, approve, status, revoke, disable, reset or registration deletion through the existing host transport. Protocol 19.1 adds confirmed registration deletion and optional `canDeleteRegistration` status, independently detected from the connector’s advertised capability; profile controls require the connector’s `cockpit controls 2` capability; older connectors report upgrade-required. Deletion disables access durably, revokes this profile’s browsers/invitations and removes its saved configuration, returning settings to Not configured. The host identity and revoked audit records remain; agents continue running. The live connector refuses later administrative requests which could recreate the deleted registration. Offline deletion requires an absent/refusing control socket, never a timeout or uncertain acknowledgement. Deletion and registration replacement first retain the old routing context in an immutable private `remote/profiles/<profile_id>/retired/` file, keyed by the service/host/credential digest. At most 32 pending records are retained; files are 0600 under a 0700 directory. Cleanup makes bounded two-second machine-only requests immediately and every 30 seconds, removing credentials only after an explicit 204; older/unavailable services and lost acknowledgements remain retryable. The supervisor stays running with no active registrations, retrying pending retirements and watching for newly configured profiles. Legacy retirements remain under `remote/retired/`. Ordinary disable/offline status preserves the registration. Deletion is local/SSH-only and absent from the encrypted remote admin schema. The relay account-list record is retired automatically once the service is reachable. Entries left by older connectors whose credentials were already erased can be removed explicitly using the confirmed Remove action in remote Settings → Hosts; names alone never identify a stale registration. Host-command values go through JSON stdin to fixed connector commands. Registration verifiers and routing credentials never enter shell commands, URLs, registry records or logs. The gateway requires exact Host/Origin and browser authorisation, rechecks authorisation after discovery immediately before mutation, serialises concurrent operations and does not replay uncertain writes. Controls remain independent of relay and daemon availability. Older connector builds are capability-detected and request an upgrade instead of receiving unsupported flags.

Desktop enablement takes the two editable HTTPS origins (initially `https://puddle.waddlelabs.ai` for the application and `https://charles.waddlelabs.ai` for the relay), a host name and browser sign-in, or reuses an existing registration. The cockpit prepares the verifier and public challenge in memory before enabling Sign in and enable. Its click opens a tab synchronously in the UI browser, or the system browser on the Electron machine, including when the cockpit targets an SSH host; no opener command is sent to the daemon. The signed-in account confirms the matching request identifier, then the cockpit polls every two seconds and submits the private verifier once through the existing connector enable command. Cancellation, expiry or closing settings discards the verifier; polling stops after an error and uncertain enablement is never retried. Changing a disabled registration replaces its displayed fields with the editable form in place, with one submit action and Cancel restoring saved values. The CLI retains manual registration-code entry. Both paths require supported persistent supervision. The UI never starts a connector tied to the cockpit's lifetime. Pairing displays a transient QR/link with expiry; pending browser cards show their exact key before approval. Pair, disable and Delete registration share one wrapping action row. Connected browsers sit under the shared, initially collapsed disclosure in desktop settings. Desktop and remote pairing QR codes share a resolution-independent SVG renderer, with a four-module quiet zone and rounded white surface. The QR surface uses the light theme’s primary foreground ink in both themes to retain scanning contrast; pairing links follow the surrounding theme’s primary text colour. Status and device rows refresh every five seconds while settings are open, with no background-window polling. Disable/revoke detach viewers without stopping agents. Host identity reset is a local/SSH-only recovery action with explicit confirmation; it disables this profile’s access and revokes its devices/invitations. Registration verifiers are cleared before enablement and invitations disappear when the settings view closes or they expire. Only public status enters the query cache.

Implement the CLI as a thin `bin` wrapper over library functions in `packages/cli/src/lib/` (bootstrap, tunnel, attach are all importable). That seam now has **two consumers — one codebase, two downstream builds**: the `puddle` bin, and the desktop shell (`packages/desktop`, Electron), whose main process calls the same `startLocal()` through the deliberate embedder surface `packages/cli/src/lib/index.ts` and points a `BrowserWindow` at the embedded cockpit's `http://localhost:<port>` origin (same UI assets, same invitation bootstrap, same authenticated gateway — the web app cannot tell the shells apart except by the preload bridge `window.puddleDesktop`, which exists solely for capabilities a renderer lacks, e.g. raising the OS window from a notification click). Shell-only concerns in the desktop package: external links and `vscode://`/`cursor://` deep links are handed to the OS; on macOS the native title bar is hidden (`titleBarStyle: hidden` with inlaid traffic lights) so the web app's top bar — which detects the bridge and becomes a drag region insetting 88px for the lights — IS the title bar (one 36px height in every shell and window state, with `trafficLightPosition.y` derived from it so the lights stay centred on the host name; full-screen drops the inset and the name EASES to the left edge rather than jumping, while the height never moves), and launch bounds fit within the primary display's work area, horizontally centre a narrower window, and always bottom-align it so even a preferred-height window in a slightly taller work area meets the lower edge while retaining native rounded corners and shadow; `POST /cockpit/refresh` maps to an in-process stop-and-restart preferring the old port (also reachable as **File → Refresh Connection**, ⌘⌥R, for the focused window — the menu path works even when the page is too wedged to serve the banner); and quitting the app normally stops only the UI server — a supervised daemon keeps agents running, while an SSH-attached fallback is cleanly interrupted and resumes on the next connection. Anything both shells need MUST live in `lib/`, never be duplicated in either shell.

On macOS the native app role is explicitly named **Puddle**, not its scoped npm implementation name, so the menu reads **About Puddle**. The About panel keeps the ordinary app version as its application version and uses the native build-version position for `Protocol <major>.<minor>`, producing one compact line such as `0.0.44 (Protocol 16.1)`.

**Desktop remote hosts.** File → "Connect to SSH Host…" (⌘⇧O) prompts for any ssh destination and runs the same `connectRemote()` the CLI uses — bootstrap over the master connection, tunnel, handshake — opening **one window per target** (local or `user@host`), which mirrors the CLI's one-cockpit-per-target model and the web app's one-daemon-per-origin assumption. Successful targets land in the host picker and a File → Recent Hosts submenu (hostnames only, in `~/.puddle/recent-hosts.json` — durable client state that survives app updates and reinstalls, migrated once from the pre-2026-07-28 userData location; never credentials — auth stays the system ssh's business). When `ssh` needs interaction, OpenSSH invokes the app's short-lived askpass helper and the app presents a serial modal: secret responses are masked, while host authenticity is an explicit Yes/No confirmation. Cancelling fails the SSH attempt. Authentication requests carry the original SSH target, independently of the displayed prompt: a new request for that target cancels its older visible or queued request and destroys the stale window before opening another; distinct targets remain serial. A helper disconnect or exiting SSH parent also removes its pending prompt, and app shutdown cancels the queue. Background reconnects therefore retain at most the latest request per target, rather than accumulating stale password or 2FA dialogues. Each dialogue displays the original target and attaches to that target’s cockpit window, using the connect dialogue or host picker only while no cockpit exists; focus on another host never determines ownership. Closing a host cancels its visible or queued request, and helpers arriving after the host closes or its initial connection fails are rejected without opening a window. The same helper remains available when an open desktop cockpit reconnects after its master lapses. Closing a window stops that cockpit's UI server and tunnel; a supervised remote daemon and its agents run on, while an SSH-attached fallback is interrupted and resumes from disk when the host is opened again.

**Desktop new windows and restore** (decision 2026-07-28, restore broadened 2026-08-13). A fresh install with no remembered windows, reopening from the dock after explicitly closing every window, ⇧⌘N (plain ⌘N belongs to the renderer's New untitled file — §11 Hotkeys), Window → New Window, and the macOS dock icon's right-click New Window all open the **host picker** — a small chooser listing "This machine" (local) on top, then recent hosts, then "Other SSH host…" (which hands over to the ⌘⇧O prompt). Clicking a row opens (or raises) that target's window; nothing connects until the user picks. The shell records opened targets immediately in `~/.puddle/reopen-windows.json` (never credentials), removes explicitly closed targets, and refreshes every still-open window's normal bounds, display id/label/work area, and — on X11 when available — EWMH virtual-desktop index before a clean app quit (including ⌘Q); the next launch reopens that standing set. Writes replace the state file atomically. Pending or failed reconnects retain their saved entries, so quitting during startup or while a host is offline cannot erase them. macOS activation and a second app launch do not open a competing picker while restoration is in progress; closing an SSH authentication dialogue during restoration does not quit the app. Connections that finish after quit begins are stopped without opening windows. macOS and X11 restore each window's monitor-relative position, clamped into the current work area and falling back to the primary display when its former monitor is absent. X11 sets `_NET_WM_DESKTOP` before mapping the restored window so it returns to its former virtual desktop without moving the user there; this is best-effort when `xprop` or an EWMH window manager is absent. macOS exposes no public stable Space identifier or API for moving a window to a particular Space, and native Wayland deliberately leaves window placement and workspace assignment to the compositor, so those platforms restore on the OS/compositor's chosen virtual desktop without private or compositor-specific hooks. A window the user explicitly closed has already left the set, including the last window whose close causes the app to quit, so it stays closed. SSH authentication can surface through the normal askpass modal, and if no target reopens the picker takes over. The picker is shell chrome like the connect prompt (its own tiny HTML + preload, outside the web app's token system).

**Desktop packaging.** The release workflow packages the app per tag (dmg + zip on macos arm64, AppImage on linux x64 and arm64, built on native runners with extraction/content/architecture checks; checksums join `SHA256SUMS`). `MAC_CERT_P12`/`MAC_CERT_PASSWORD` enable Developer ID signing under hardened runtime; `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` add notarisation. Without certificate secrets, macOS releases use an **ad-hoc app signature** (`mac.identity=-`, hardened runtime and notarisation disabled because ad-hoc frameworks have no Team ID for library validation), and CI verifies the complete bundle with `codesign --verify --deep --strict` before publishing. The ad-hoc branch unsets `CSC_LINK` and `CSC_KEY_PASSWORD`: GitHub exports missing secrets as empty strings, which electron-builder otherwise interprets as a certificate path relative to the desktop directory. Every desktop packaging branch passes `--publish never`; only the release job publishes the complete, verified artefact set. Disabling signing with `mac.identity=null` leaves Electron’s linker signature with no bound Puddle identity or sealed resources, failing bundle verification. Ad-hoc signing requires no Developer Program membership and supplies no Developer ID trust or notarisation; Gatekeeper approval and notification authorisation remain separate. A valid seal alone does not establish notification delivery; installed-app acceptance must cover permission, banners, clicks and upgrades.

**Desktop self-update** (decision 2026-07-28). No Squirrel and no electron-updater — Squirrel.Mac requires a trusted signing identity, while releases without certificates use ad-hoc signing (above) — so updates take the CLI's own path: `lib/desktop-update.ts` checks the GitHub releases API, downloads the platform asset into `~/.puddle/cache/desktop/<version>/`, verifies it against the release's `SHA256SUMS`, unpacks (`ditto` for the mac zip; the AppImage is the artefact itself), and swaps via a detached `/bin/sh` helper that waits for the app to exit, moves an existing install aside when present, moves the new one in (copy fallback across volumes, restore on upgrade failure), strips `com.apple.quarantine` recursively from the installed bundle (a no-op in the normal path — belt and braces against a bundle that acquired the attribute some other way), and relaunches. On Linux the swap targets `$APPIMAGE` — the running file's own absolute path — so a user-relocated AppImage updates in place, keeping the path launchers point at (the version-in-filename going stale is accepted). Fetches carry no Gatekeeper quarantine (only opted-in apps like browsers attach it — the same reason the curl-piped install.sh works unsigned), and the trust model is exactly the daemon bootstrap's: the GitHub release is the root of trust, the checksum guards transport integrity; signing can later replace the swap mechanism without touching the UX. The shell polls half-hourly when running from a real install (never in dev; six-hourly through v0.0.34), stages silently, and offers a **dismissable toast** ("Restart to update") through three preload-bridge members; the renderer never sees URLs or paths. The toast replaced a permanent bottom bar in v0.0.29 (decision 2026-08-05): dismissing it parks the offer until the next staged version or app launch, since an update demands nothing immediate. An update relaunch inherits the ordinary durable window restore above, so it lands on the same targets without a separate one-shot path. Because the check asks `releases/latest`, an app several versions behind stages **only the newest release** — and the staging cache self-cleans: each successful stage prunes every other version under `~/.puddle/cache/desktop/`, and boot prunes the lot (`pruneDesktopUpdateCache` in `lib/desktop-update.ts`; a leftover stage is re-downloaded fresh by the next poll anyway), so successive releases cannot accumulate one download per version. `puddle upgrade desktop` drives the same pipeline from a terminal while the app is closed (a running app must use its toast — an external swap would wait on a process that isn't exiting). On macOS it is also the first-install path: when neither `/Applications/Puddle.app` nor `~/Applications/Puddle.app` exists, it downloads the latest release and installs into system `/Applications` when writable, otherwise creates and uses `~/Applications`; the helper does not require an old bundle to move aside. On Linux, `puddle install desktop` supplies the otherwise-missing conventional path and the running AppImage continues to update itself in place. The release workflow still publishes no electron-updater metadata (`latest-*.yml`/blockmaps) — nothing consumes it. The app icon is the puddle mark in dark-theme gold on navy, from two committed sources rendered by `scripts/render-icon.sh`: `packages/desktop/build/icon-mac.svg` (full-bleed → icns; macOS 26+ masks icons into its own squircle and plates self-rounded artwork on white) and `icon.svg` (self-rounded squircle → png, for Linux, which applies no mask).

## 11. Profiles and projects

The collapsed right rail's session island grows only to the available space between
its fixed controls and bottom archive button; overflow scrolls inside that island.
Project groups do not acquire independent outlines or backgrounds. Collapsed project
abbreviations shrink only as needed to show their full text without ellipses, capped
at the normal label size. Recalculate on rail width and UI font changes.

The right session sidebar keeps every non-archived project visible as a navigation target, including projects with no sessions. Expanded groups use clickable project-name headers; the collapsed rail shows a **≤5-character uppercase abbreviation** within a single content-sized, scrollable session island, with horizontal dividers between projects (the project's stored `abbrev` — chosen at creation, editable with the name in the homescreen card's Edit dialogue — or derived from the name's first five characters when unset) and uses the session's agent or terminal glyph; the label's tooltip shows the full project name. A **double-click** on any project's label opens that label's own MENU — the same one a right-click gives (decision 2026-08-05, replacing the double-click-to-rename of 2026-08-03): renaming is one of several things the menu offers, so jumping straight into the rename editor chose for the user, and the abbreviation editor in particular opened over a 5-character label that gives no hint it is a text field. The double-click's own first click navigates, making that project active; a single click still just navigates; and the editor is one click further in, under "Change project name" / "Change project abbreviation" (commit on Enter/blur, Esc cancels). A project name (header or collapsed label) right-clicks into a menu that starts a **new agent or new terminal in that project** — the same create dialogue the sidebar's fixed controls open, seeded with that project — and, below a divider, **edits the label under the cursor**: "Change project name" on the expanded header, "Change project abbreviation" on the collapsed rail (each menu offers exactly the field that header shows, so neither surface has to host an editor for something it does not display; since 2026-08-05 this menu is also what the double-click opens, making it the one route to the editor). The name also **drags to reorder projects**: while a name drags, every group's session list collapses so only the names reposition, and the drop persists into the same `profileSettings.projectOrder` the homescreen cards drag (one source of truth for project order, both sidebar modes). With `showAllProjectSessions` off (§12), other projects retain their labels while their sessions are hidden.

Profiles are identity, not auth. First load shows a profile picker (create-or-select), remembered in localStorage.

The new-session account picker sorts alphabetically by its displayed `agent-type/account-label`, without changing the profile's configured default account.

### Workspace and inline motion

Project-scoped layout changes, saved-layout changes, project/profile layout mode changes and
dashboard/workspace navigation and the full-screen profile picker cross-fade
outgoing and incoming content together,
using the modals’ 180 ms fade and gentle growth. Outgoing layers are inert,
short-lived visual copies; live editor models and terminal portals retain their
existing lifetimes. Copies never mount browsing contexts, media or interactive
controls. New tabs and their viewing areas fade in; replacing the content of an
existing italic preview slot stays immediate. Activating an existing tab or focusing
another pane is immediate, including across projects in a profile-wide layout.
Closing the active tab retains the content cross-fade to the remaining tab or empty pane.
File-tree Up/Down previews the selected file without moving keyboard focus;
Enter pins it, Space previews it,
and modified/range selection does not open files. Directories retain their
expand/collapse behaviour.

Both session sidebar modes retain inactive project rows inside a height/opacity
accordion, excluding folded rows from focus, selection ranges and drag batches.
Tab fills and hover controls clip to the pane’s rounded edge; the island outline
is painted above them. Native file/session drops and tab drags unfurl the live
destination from the source row/chip, while whole-pane moves and their neighbours
settle into their new geometry. These animations do not change drop semantics.
Opening/closing the dashboard terminal, Scratchpad creation/editing and Layouts
creation cross-fade their content
while animating actual height, so following controls slide continuously. Reversals
start from the current height. Client or OS reduced motion disables decorative
work and cancels active animations; timers and snapshots are cleaned up.

### Settings

Right-clicking the header host/profile identity opens shared Rename and Change
colour actions. Renaming uses the existing inline editor and store; colour
choices use the same preset/custom picker as Settings and project menus. The host
menu also opens Settings → Host at its Updates section. Ordinary host navigation
and profile-panel clicks retain their existing behaviour.

Host appearance is stored in the connected daemon's profile settings (`hostIcon`,
`hostColour`), so each (host, profile) pair has an independent identity. These keys
are excluded from Settings Sync exports and imports. Host settings offer 63 curated
playful icons, distinct from the 63 profile icons, plus a default server glyph
and the shared theme-aware colour palette. Profile colour, project colour and host accent also
accept a custom six-digit hex colour, selected with the system colour picker
seeded from the current choice (custom host accents require protocol 26.5;
custom project colours require 26.6). All three use one shared picker: presets
remain available alongside the custom option, and the default swatch uses a
fixed neutral grey independent of host accents. Project custom colours carry
through cards, the command field, expanded/collapsed sidebars and mobile labels.
Generated host palettes retain readable text and selection contrast for arbitrary
colours. Host accents change palette values, never the relationships between UI
surfaces: pane frames and tab strips share the sidebar's `--bg-surface` through
the default `--bg-pane` alias, which host palettes never override. Nested trays
use `--bg-tray`. Editor/terminal reading
surfaces and active tabs retain the default `--bg-base` (white in light mode,
deep navy in dark mode). The default theme retains its original surface colours.
Preset and custom accents blend island, elevated and tray backgrounds one-third
of the way from their original theme colours to the full accent tint, with nested islands
one further step from the reading surface. A neutral foundation retains depth
even for white or black custom accents. Accent borders are darker than every
surface in light mode and lighter in dark mode, maintaining at least 1.5:1
contrast against reading, island and nested backgrounds. Default borders stay
unchanged. Accented form fields and inactive switches use the lighter file-hover
fill, with a subtle deeper fill on interaction; checked switches retain the action
fill. Default controls stay unchanged. There is no separate pane/tab contrast adjustment.
Compact Icon and Accent rows sit below
the display name, without a separate section or preview card. A chosen accent
rebuilds the entire chrome palette: text hierarchy, surfaces, borders, controls,
links, focus rings and persistent selections. File/session selections use a softer
fill. Neutral ink updates with the palette while reading backgrounds remain theme-owned;
syntax and ANSI hues, semantic status colours, explicit project/profile colours,
brand/file artwork and document colours remain independent. Palette changes notify
the existing editor/terminal theme subscribers using resolved hex colours.
The desktop shell caches the last viewed profile's host name, colour and a bounded
outline-glyph snapshot per connection target in `desktop-host-identities.json`.
New Puddle Window uses this presentation even while a host is offline, retaining
the original SSH target for connection and a tooltip; unknown hosts fall back to
the target and server glyph. Only the registered cockpit's main frame can update
its own target's entry. The cache contains no credentials or connection authority.
Hold ⌘⌥/ on macOS or Ctrl+Alt+/ on Windows/Linux to blur the existing workspace
and overlay the chosen host glyph above its name in large centred type, enclosed
in a rounded outline with no fill. The overlay has no opaque/tinted replacement background, preserves editor focus, and disappears
immediately when any chord key is released or the window loses focus/visibility.
Key repeat does not toggle it. The binding is customisable in Hotkeys; entrance
motion respects reduced motion and dismissal has no exit animation.
Without a chosen accent the original theme returns, including gold navigation
selection. The palette is cleared when leaving the host/profile.
The existing extensible profile-settings API stores these optional fields without a
migration; older clients preserve them without displaying them.

A settings panel, reachable from a gear icon and ⌘K → "Settings". Three scopes, each stored where it belongs:

| scope   | storage                                                    | examples                                                                                                                                                                                                                                              |
| ------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| client  | localStorage (per browser)                                 | theme (dark/light/system), cursor package, UI, terminal, and Monaco editor font sizes, terminal scrollback, editor tab size / word wrap (the explicit tab size controls spaces per indent level and disables Monaco's per-file indentation detection) |
| profile | `profiles.settings` JSON, via `/api/profiles/:id/settings` | branch prefix, default account & agent, permissions gate, env capture (`captureSessionEnv`), notification preferences, per-kind new-session defaults (`sessionDefaults`)                                                                              |
| daemon  | `config.json`, via `/api/config`                           | host display name (`displayName`), log size cap, ui_state GC retention, `autoResume` — marked in the UI as affecting all profiles. The port is CLI/config-file territory (`--port`), never shown in the UI                                            |

Appearance includes **Show host when returning to the window** (`showHostOnFocus`,
client scope, off by default and included in Appearance sync). Returning to a
focused, visible cockpit window or browser tab briefly shows the large host icon
and name. On macOS it appears instantly, holds for 0.4 seconds, then fades out
over 120 ms (or disappears immediately with reduced motion); other platforms retain
the 1.2-second reminder. These two motion options sit below project-based layout
and session visibility in Appearance. Typing, clicking or scrolling dismisses the reminder
without consuming the input or moving focus. Leaving the window clears it;
repeated focus events do not extend it. Mac activation uses a leading-edge
debounce: after the first reminder, focus signals must be quiet for 750 ms before
another return can show it; intervening blur events do not reset that interval,
and no delayed reminder is queued. The fade retains its transparent final frame
until removal. The desktop shell also forwards native
window focus/blur across Mission Control and Spaces; visibility/native activation
does not wait for Chromium’s lagging document-focus flag. Activation clicks and
modifier synchronisation do not instantly dismiss the reminder. Releasing any
shortcut key, including a modifier whose event still carries stale modifier flags,
immediately removes the held overlay. The Mac shell bundles a small Node-API
AppKit shim that forwards app-local Command key-up events to the key window before
NSApplication can swallow them; it uses no global keyboard monitor or permissions.
The native regression check posts real AppKit key-down/up events, since CDP input
bypasses this path. The same compact icon and label styling, borderless transparent overlay
and blurred backdrop appears while holding **⌘⌥/** on macOS or **Ctrl+Alt+/**
elsewhere (`host.peek`, rebindable in Hotkeys). Holding the shortcut takes over
from the timed reminder until key release, Escape or focus loss. Both respect
reduced motion and leave workspace state intact.

Panel sections: **Appearance** (theme, cursor package, font sizes, density); **Profile** (name — also editable by **double-clicking the profile name in the top-bar profile button**, which closes the panel the first click opened, since the name IS its trigger (decision 2026-08-03); editing retains the trigger’s spacing and typography, with the input sized to its current text so neighbouring icons move only as the name grows or shrinks; a name must stay filesystem-safe (it is a directory under `~/.puddle/profiles/`), so an invalid or clashing one is rejected and surfaces as a toast — branch prefix, **icon** — one of a curated set of ~60 lucide glyphs, all statically imported (no lazy chunks), picked from a small grid — and its **colour** — any theme-colour key, mapped to a theme-aware `text-*` token; the chosen glyph AND the profile name beside it recolour wherever the profile appears: the top-bar profile button and the profile picker — default account & agent); **Accounts** (per agent type: login state, add — spawns the login PTY —, remove; per-account "skip permission prompts" toggle, visible only when the gate below is on); **Sessions** (in order: the permission-skip gate, the env-capture toggle (`captureSessionEnv`, §4 Captured session environment), the daemon's agent search path, terminal scrollback, the per-kind new-session defaults (`profileSettings.sessionDefaults`: base branch, separate branch, separate directory — what the new-agent/new-terminal modal OPENS with, every value still editable per session; built-ins when unset: both kinds share the base branch's directory, since 2026-08-03), then the editable launch-text templates of §4 — `profileSettings.onboardingTemplate` / `concurrentTemplate` / `restartTemplate` — then the tab-title template); **Editor** (tab size, word wrap, the editor-link SSH host, and profile compilation defaults selected by language — directly below Sessions; the old combined "Terminal & Editor" section is gone, its `#settings/terminal` deep link resolving to Sessions); **Hotkeys** (rebind the app's global shortcuts — see below); **Notifications** (protocol 22.3 adds session-scoped `agent-notification` events on waiting for input and unrequested agent exits; deliberate stop/archive/delete/shutdown stays quiet. Terminal placements retain shell status and receive notifications only for agents observed in the main PTY: adapter busy/idle patterns report completed turns, and successful process inspection reports child exits without confusing suspension or inspection failures with completion. Codex native app-server turn events drive its status in order with conversation rebinding; regexes remain the fallback. Desktop and mobile workspaces subscribe; older daemons retain status-based waiting notifications. Protocol 22.5 adds optional notification content: the conversation display name (user title, agent title, terminal title, then id prefix; at most 160 characters), a last-output snippet (at most 256 characters), and immutable project/session ids. Exact Codex and Claude conversation readers asynchronously inspect at most 128 KiB of transcript tail for the latest assistant text, excluding reasoning and tool records; other agents and terminal placements use a bounded plain-text tail of the existing terminal emulator. Empty output retains a waiting/exited status message. Preview reads do not enumerate transcript bodies or change terminal geometry. The event captures its original placement before asynchronous work. Native desktop notifications retain validated destinations in the main process, and the shell listens on mount so clicks still navigate after a renderer reload. Each desktop click explicitly activates the destination terminal and its pane, opening a missing tab in the destination project’s layout; it also reactivates a terminal hidden by an editor when the URL already names the same session. Repeated clicks each activate once, without stealing focus back from later file-tab selections. Persistent browser notifications retain their destination for worker restart and closed-tab clicks. Delivery uses: a desktop notification — permission requested by the toggle click, shown even while focused by default (`notifications.when_focused`, protocol 22.2; users can disable delivery during interaction; in the desktop cockpit only trusted typing, pasting or pointer presses inside that session’s main terminal count as focused, for five seconds after the latest input. Window focus, an open or visible tab, mouse movement, scrolling and terminal output do not count. Activity elsewhere, leaving the window, hiding or closing the terminal end suppression; sounds retain their independent toggle), clicking it opens the session — plus an optional WebAudio sound and a `(n)` document-title badge counting waiting agents; per-project mute silences both. The toggle defaults to on but the browser prompt needs a user gesture, so the row surfaces the LIVE permission state whenever the toggle is on but delivery cannot happen — unrequested (with an inline request link), blocked, or unsupported — re-read on window focus so a grant made in browser/OS settings is picked up. Electron uses native main-process notifications through bounded, main-frame-only IPC; its preload bridge never implies OS permission. Protocol 24.1 adds an optional bounded desktop notification subtitle. Every desktop platform displays the host label and project name first (`host · project`), then the session title, then the output preview or waiting/exited message. macOS uses the native title/subtitle/body fields. Windows uses three escaped text blocks in a ToastGeneric payload, retaining silent delivery and exact click navigation. Linux places the session on the first body line above the preview; the desktop environment controls wrapping and styling. The host label follows its custom display name, falling back to hostname. The renderer capability-detects `notificationSubtitles`; older shells retain their session-title/body layout. Web/mobile notifications use `[ABBRV] Session title` as their single title field and retain the preview in the body, for both live delivery and encrypted background push. `ABBRV` follows the saved project abbreviation or the project rail’s uppercase first-five-character fallback; the complete title remains bounded to 160 characters. Generic notification tests and pushes without an available preview retain their generic title. Settings offers a test and shows native failure details or unconfirmed delivery. An explicit macOS `UNErrorDomain` code 1 adds instructions to enable Allow notifications in System Settings → Notifications → Puddle and explains that a missing Puddle entry may require a build with a valid app signature; the native detail is retained within the existing 512-character limit. Other native errors remain unchanged, and a successful retry replaces the earlier failure. Browser delivery prefers a notification-only service worker (required by mobile browsers); it never caches content or intercepts requests. Constructor and service-worker failures are surfaced. This live event path needs a connected browser; the remote app’s separate per-device Web Push opt-in handles closed/background delivery (§6). macOS delivery requires app signing and system approval; the Gatekeeper quarantine override does not grant notification permission. Delivery looks the session up across the query caches and falls back to fetching the all-sessions list when absent — a tab parked on the dashboard holds no session cache and must not silently drop notifications); **Projects** (per repo: base branch — empty follows the clone’s current branch for each new agent/terminal — fetch policy, onboarding notes; standing setup rules, freely editable); **Host** (daemon scope, incl. `fetchIntervalMinutes` and the host display name — also editable by **double-clicking the host label in the top bar**, where clearing it (or typing the real hostname back) unsets `displayName` so the label falls back to the hostname rather than storing it twice); **Remote & Sync** (host remote-access controls, then the "Sync locally" mirror, one shared what-to-sync checklist, one-click export-and-copy, then paste-import — see below).

**Permission prompts are ON by default, everywhere.** Spawning an agent with prompts skipped (e.g. `--dangerously-skip-permissions`) requires deliberate, layered opt-in:

1. The profile's `allowSkipPermissions` gate (Settings → Sessions) is **off** by default. Enabling it shows a warning dialogue that spells out what an unattended, prompt-free agent can do, and requires typing the profile name to confirm. That confirmation is also the human consent for the agent's _own_ skip disclaimer: on gate-open the daemon calls `adapter.acceptSkipPermissions` for each of the profile's skip-capable accounts (for Claude Code, recording `bypassPermissionsModeAccepted` in the account's `.claude.json`) — otherwise Claude 2.1.x silently downgrades `--dangerously-skip-permissions` to normal prompts, since its disclaimer is only acceptable interactively and a puddle PTY is not. Verified against Claude Code 2.1.210.
2. With the gate on, individual accounts can opt in (`skip_permissions_default`), and only then does the new-session modal show a per-session skip toggle. Opting an account in also records the agent's skip acceptance for that account (as gate-open does for the profile's existing accounts), so an account added after the gate was already open still skips correctly.
3. The daemon enforces the gate server-side: `skip_permissions: true` against a closed gate is rejected — there is no CLI, API, or UI bypass.
4. **Re-evaluated on every spawn-like action.** The effective flag for any launch — create, resume, migrate, or hand-off — is `requested ∧ profile gate ∧ target account opt-in`, evaluated at that moment. A session that ran without prompts does not carry the flag through a resume after the gate was closed, and a migration or hand-off never inherits it onto an account that hasn't opted in; the session continues with prompts on (and says so in the terminal).

Turning the gate off later immediately hides the toggles; already-running sessions are unaffected but are badged so it's visible which live sessions are running without prompts.

### Hotkeys

The command palette excludes archived projects and lists projects in the sidebar's saved `profileSettings.projectOrder`, with the same newest-first fallback for projects without a saved position.

The app's **global** keyboard shortcuts are a customisable registry (Settings → Hotkeys), stored per profile in `profileSettings.hotkeys` (action-id → a canonical binding string like `shift+meta+KeyE` — modifiers in the fixed order `ctrl`,`alt`,`shift`,`meta`, which the dispatcher compares by equality, so an out-of-order default silently never fires; absent = the built-in default). One module (`lib/navigation/hotkeys.ts`) owns the action list, binding format, and a runtime handler registry; components register a handler for their action on mount, and a single global dispatcher (`HotkeysHost`, mounted in the shell) turns a keydown into the matching action. When Monaco has focus, the shell captures app-global shortcuts before the event reaches the editor — Monaco uses ⌘K as a chord prefix and otherwise swallows it before a bubbling listener — while editor-owned actions still reach Monaco. **Scope is the global/layout actions only** — command palette, close tab, reopen last closed tab, new untitled file (the keyboard route to the strip's blank-tail double-click, §8 — a fresh draft in the focused pane), next/previous tab in the focused pane (strip order, wrapping at both ends, and NOT deferred in a terminal — switching away from the terminal you are typing in is the point), close window, toggle left/right sidebar, open a left navigator (Files/Search/Changes/Worktrees), new agent, new terminal, toggle Scratchpad, toggle Layouts, plus the two editor actions (save, word wrap) which are bound inside Monaco from the same registry. **Project switching** uses ⌘0 for the first non-archived project through ⌘9 for the tenth, in the current profile’s homescreen/sidebar drag order (new projects retain the same newest-first ordering). These ten shell-owned actions work on the dashboard and in workspaces, respect per-profile rebinding and terminal shortcut policy, and do nothing for an empty slot. The command palette shows each project’s current binding. Browser chrome may reserve these combinations; desktop Reset Zoom moves to ⌥⌘0 so plain ⌘0 reaches project navigation. **Reopen last closed tab** (decision 2026-08-03) pops a per-window, in-memory stack of closures — each remembering the pane and the position in that pane's strip — and puts the tab back through the same `center`-drop path a drag takes, so it returns permanent and focused; a pane that has since collapsed sends it to the focused pane instead, and a tab whose session has been archived or deleted is dropped from the stack rather than resurrected. The stack is keyed by layout scope, so it reopens within the profile-wide surface or within that project's own layout, never across the two (§11 reload semantics). Untitled drafts are excluded: closing one deletes it. **Close window** is a shell action (it works on the dashboard too): the desktop shell closes the window over the preload bridge, since a renderer cannot close a window it did not open. **Filetree navigation and terminal line-edits stay fixed** (conventional, context-scoped). The settings panel records a keystroke per action, resets to default, and flags **conflicts** (two actions sharing a binding). Browser-reserved combos (⌘W, ⌘T, …) are bindable without warnings — a web tab simply can't intercept them, which users can discover for themselves (decision 2026-08-03, retiring the earlier reserved-combo flagging). An action may be flagged `deferInTerminal` to yield to a focused terminal that uses the key itself. **App shortcuts win inside terminals** (`profileSettings.terminalAppShortcuts`, 14.2 — a switch atop Settings → Hotkeys, living with the bindings it governs; default ON, 2026-08-06): xterm consumes chords it can encode before they bubble to the dispatcher — ⌃⇥/⌃⇧⇥ tab cycling died inside a focused terminal — so the terminal's key handler yields any chord bound to a registered, non-`deferInTerminal`, non-editor action (returning it unhandled, so it bubbles to `HotkeysHost`). Off, the terminal receives every key it can handle and only chords xterm ignores reach the app. Per profile, like the hotkey overrides themselves: which keys your muscle memory owns is a fact about you, not the browser you happen to be in. **Every place that NAMES a shortcut in UI copy reads the live binding**, never the default: the top bar's command field, an empty pane's palette button, the empty session list and empty dashboard, and the draft-save prompts all resolve through `useHotkeyLabel(actionId)`, so a rebind is honest across the whole UI at once. The fixed keys (filetree ops, terminal line-edits) still spell themselves literally, since nothing can rebind them. Defaults (Mac): ⌘K palette · ⌃⌥W close tab · ⌃⌥T reopen closed tab · ⌃⌥N new untitled file · ⌃⌥] / ⌃⌥[ next / previous tab · ⌘W close window · ⌥⌘, / ⌥⌘. left/right sidebar · ⌘S save · ⌥Z wrap · ⌥⌘E/F/V/B Files/Search/Changes/Worktrees · ⌃⌥\` new agent · ⌃\` new terminal · ⌥⌘S Scratchpad · ⌥⌘L Layouts. **Two default sets** (decision 2026-08-03): those web defaults dodge browser-chrome combos; the DESKTOP shell (detected by the preload bridge) forks the ones where a native gesture is more intuitive — **⌘W** close tab, **⇧⌘W** close window, **⇧⌘T** reopen closed tab, **⌃⇥** / **⌃⇧⇥** next / previous tab (the universal tabbed-app gesture, which a browser tab can never see because the chrome switches its own tabs), **⌘B** / **⇧⌘B** left / right sidebar, **⌘T** new agent, **⌘N** new untitled file (the shell's New Window menu item yields the key, moving to ⇧⌘N) — via each action's optional `desktopBinding`. The sidebar pair is deliberately ⌘B and ⇧⌘B rather than VSCode's own secondary-sidebar ⌥⌘B: that combination is Open Worktrees here, and a pair the eye reads as one gesture beats matching a foreign app key-for-key (decision 2026-08-03). A browser keeps ⇧⌘B for its bookmarks bar, which is why only the desktop default forks. Its File → Close Window keeps the ⇧⌘W glyph but sets `registerAccelerator: false`, so the key reaches the renderer and a rebind genuinely moves the shortcut (clicking the item still closes); plain ⌘W likewise reaches the renderer, where it closes a tab. Only the defaults fork: `profileSettings.hotkeys` overrides apply in both shells, and the settings panel shows and resets to the set the current window runs.

### Remote & Sync

Remote access and profile sync share the final settings sidebar entry, `#settings/remote-sync`, in the former Sync position. Legacy `#settings/remote` and `#settings/sync` links open that same section. Each group retains its own heading and host/profile scope. Remote status updates every five seconds without dimming controls, changing button labels, or disturbing drafts/focus. Explicit actions wait for any current status read before dispatch; periodic, focus and reconnect refreshes pause during mutations.

Settings → Remote & Sync moves a profile's **machine-agnostic** settings between machines. It spans the per-browser client settings, the theme preference, the profile's settings JSON (including `captureSessionEnv` and the desktop/sound notification toggles — never `muted_projects`, whose project ids are host-local: they are stripped on export and preserved through import), a few profile columns (branch prefix, icon, colour), and the profile's **profile-scoped Scratchpad entries**, grouped for one shared checklist — **Appearance · Profile · Sessions · Editor · Hotkeys · Notifications · Scratchpad**, mirroring the settings sidebar's tab order (`lib/settings/settings-sync-manifest.ts` is the single definition; every sync path routes through it). It deliberately excludes anything that can't map onto another machine: accounts, repositories, project order, default account, the daemon's agent search path, worktree paths, project-scoped scratchpad entries, and compilation commands whose executable paths belong to the connected host.

Two carriers:

- **The string**: **Export is above import** and takes one click — it builds the string from the checklist, shows it, and copies it to the clipboard immediately (no separate copy step). Import follows it and updates only the fields the pasted string carries, routed back to their stores. The codec (`lib/settings/settings-sync.ts`): `JSON → gzip → base64 → append the gzip bytes' CRC-32 → a random Caesar shift over a fixed alphabet`. gzip+base64 always begins with `H`, so the decoder maps the received first character back to `H` to recover the shift (no marker needed), then verifies the CRC before applying — a jumbled blob that round-trips exactly and rejects a corrupted paste.
- **Sync locally** (default ON since 2026-08-03 — a profile with no stored entry syncs every group until toggled off; the first export pass persists the entry): mirrors the selected groups through the cockpit's machine-shared store (`GET/PUT /cockpit/local-sync` → `~/.puddle/local-sync.json` on the CLIENT machine — §10), keyed by **profile name**, so every puddle window on the box follows — across UI ports (separate localStorage origins, which is why plain localStorage cannot do this) and across daemons. While enabled, the checklist governs **both directions**: a window applies the store's doc on load/focus and mirrors its own changes back out (`use-local-sync-engine.ts`; the import pass runs first and the export pass waits out its in-flight patches, so the two never fight). Embedded cockpits without a local store hide the option; Vite uses the same authenticated store.

**Scratchpad sync never overrides.** In both carriers, imported entries are ADDED unless an existing profile-scoped entry is exactly identical in title, body, tags (order included), and agent association — then the duplicate is skipped; any difference keeps both copies. Ids, positions, and timestamps never travel.

### Scratchpad

Each profile owns an editable Scratchpad — a bank of reusable prompts and free-form notes ("write tests for what you just changed, then run them", "summarise the diff against base as a PR description", review checklists, house style rules, or just a note to self). It is a **top-bar popover** — its trigger sits between Settings and the profile button, and it opens a floating, scrollable panel anchored under it (the profile panel's pattern), never taking centre stage. It works from the dashboard too (profile-wide entries only there); inside a project it also lists that project's entries and can insert into the workspace's focused terminal.

- **Scope is a hard filter** (deviation from the earlier prompt-bank design, where the project was only a ranking hint). Every entry is either **project**-scoped — shown only in that project — or **profile**-scoped — shown in every project of the profile. In a project the panel lists the profile-scoped entries plus that project's own, in one ordered list; the scope is editable per entry (a toggle in the inline editor), and a new entry defaults to project scope.
- **Order is manual.** The whole entry row is drag-reorderable (no grip handle), newest on top; the order persists as a REAL `position` per entry (smaller = higher), so a profile-scoped entry keeps a consistent order across projects while project entries interleave per project. A drag writes only the moved entry's fractional midpoint position.
- **Filter** the list by `tags` (chips) or `agent_type` (brand icons) present in it — narrowing only, never hiding a scope.
- **Insert flow**: an entry's **Insert** action **pastes the body into the focused terminal's stdin without submitting** — wrapped in bracketed-paste sequences (`ESC[200~ … ESC[201~`), because a raw multi-line write would let each newline submit a partial prompt to the agent — plus **Copy** to the clipboard, **Edit**, and **Delete** (which asks for confirmation inline — a warning line with Delete/Cancel, since there is no undo). Only a focused terminal/agent tab accepts stdin; otherwise the insert nudges you to focus one.
- **Reading layout**: an entry is text first — the optional title, then a readable multi-line body preview — with a single meta line BELOW the text carrying the scope label (Profile-wide/Project), agent mark, tag chips, and the entry's tools. The tools are **always visible** (never hover-revealed), so pointing at the list reflows nothing.
- **Management is inline — no modal.** `+` opens a spacious composer at the top of the list; a **click** on a row expands that row into the same editor in place (multi-line body with room to breathe, optional title, scope toggle, comma-separated tags, optional agent association; ⌘↵ saves, Esc cancels). A click on the row's own action buttons does not open the editor. Outside a project the scope toggle is absent — entries there are profile-wide by definition.
- **v1 is literal plaintext**: no templating variables, no sharing between profiles (a coworker's bank is theirs; copy-paste is the sharing mechanism). Both are possible later; neither should complicate v1.

### Layouts

Saved layouts (12.2) are named snapshots of the centre tiling tree a profile can save and load. The **Layouts popover** is a top-bar popover between Settings and the Scratchpad, in the Scratchpad's mould (anchored panel, inline management, no modal). It is a LIST, not a dashboard (redesigned 2026-08-03): the live layout's own state is carried by its ROW, so nothing above the list repeats it. The current layout's **name reads green with `Active`** when it matches what is saved and **red with `Unsaved`** when the live tree has drifted. Drift is a structural comparison (`layoutSignature`): node ids, active/preview tab focus, and sub-0.1 resize noise are ignored — switching tabs is not a layout change — while tab identity, split structure, and pane proportions count. What sits above the list is only ever the name FIELD for the live layout: permanently while it has no row of its own — "Unnamed layout", the scope a save would capture (the current **project** under `projectBasedLayout` — the default — and **profile**-wide with it off), `Unsaved`, and the field that names it — and on demand from `+`. The captured payload is exactly the scoped slice — `{layout_tree, active_session}` — never shell chrome (sidebar modes and sizes stay live state). **Under project-based layout the catalogue narrows to the open project's layouts plus the profile-wide ones**; otherwise it is the whole profile's (the `?project=` filter on GET /api/layouts remains for other callers). Hiding other projects' rows is what leaves **exactly one current layout** in the list at any time — their slices carry their own `layout_ref` and are still restored on arrival, they simply are not shown or markable from a project they do not belong to. A project name under a row is what marks its scope: **profile-wide rows carry no label**, since that is the absence of one. The list stays **filterable by project** — chips in the Scratchpad's mould over what the catalogue actually holds, narrowing only, hidden when there is only one kind to show. **Every row carries four actions** — rename, save-as (save glyph), duplicate (copy glyph), delete — and everything they write takes the provenance the CLIENT SETTING implies right now, never the row's own: scope is fixed at creation, so a save-as invoked from another scope's row writes the current scope's namesake (created when absent) rather than moving a layout between scopes. **Save-as on the current layout is simply Save.** On any other row it asks first — "Overwrite “X” with the current layout?" for a row it can write in place, or "Save the current layout as “X” here?" when the row belongs to another scope — and then the live layout adopts the result as its name, exactly as Save As does elsewhere. **Duplicate means the same thing on every row**: a copy of what is SAVED there under a name asked for inline, leaving the live layout — and which layout is active — exactly as they were. Duplicating the current layout therefore copies its saved version WITHOUT the unsaved changes on top. Creating from the live layout is a different act with its own affordance: **`+` in the header** (the Scratchpad's composer gesture) opens the same name field an unnamed layout shows, saves the live layout under that name with the provenance the setting implies, and makes it the active layout. A save-as targets the row that was clicked, never one resolved by name — nothing stops two layouts sharing a name. **Loading a project-scoped layout makes its project the active one**: the load lands in that project's slice, flips `projectBasedLayout` on if it was off, and follows the URL to `/project/<id>` — without which the workspace would sit in a project whose slice is not the one just loaded and nothing visible would change. Rows load on click, and rename, naming a copy, and every confirm expand inline; the discard-confirm is computed against exactly the state a load replaces — the visible head for the open project's own layouts and profile-scoped loads under profile mode, the target project's slice for cross-project loads (its unnamed content or drift from its `layout_ref`), both for a project-scoped load under profile mode (the live profile layout shards away AND the target's preserved slice is replaced) — and a profile-scoped load under project mode confirms nothing, because it retains every slice. **The dashboard loads (and saves) too**: the layout state exists whether or not a workspace is mounted, so without one the popover drives the persisted snapshot directly (`useDashboardLayouts` — the working set over the profile row, written immediately rather than debounced; safe because no workspace `useUiState` handle is alive in that window to race with), and the next workspace open restores the result. Under the profile-wide mode the dashboard behaves as a workspace does (the profile layout is the current one, and its row says so); under project-based layout there is no single live layout at all — every project keeps its own — so the popover says that in place of any head, drops the row actions that would need one, and still loads, with the discard-confirm computed against the target project's slice. Loading prunes the stored tree against the daemon's full live-session list (untitled tabs always keep), and when it would discard unsaved changes an inline confirm warns first. The live layout keeps persisting exactly as before — closing and reopening the app never changes it; a saved layout is only a named restore point.

**Cross-scope loads flip the setting, with the conversion suppressed.** A saved layout remembers the mode it was captured in, and loading one whose scope disagrees with the client's `projectBasedLayout` setting switches the setting as part of the load — stamping `layout_mode` and writing the target state BEFORE flipping the setting, so the one-shot union/split conversion (Reload semantics below) finds the snapshot already converted and cannot overwrite the layout being loaded. Loading a **profile**-scoped layout under project mode installs its tree top-level and turns the setting off; the union that a plain toggle would run is suppressed, and the stored `project_layouts` slices are left in place rather than cleared — nothing is erased. Loading a **project**-scoped layout under profile mode splits the current profile tree into the OTHER projects exactly as the plain toggle would, while the current project takes the loaded layout instead of its shard. In every split — load-driven or plain toggle — a shard never overwrites a stored slice (`mergeShardedLayouts`: existing slices win, shards fill only the gaps), so per-project layout storage survives the round trip.

**Projects are the workspace unit.** A project belongs to one profile and one repo, and owns a set of sessions (persisted UI state belongs to the profile — see Reload semantics below). The dashboard (`/`) lists the current profile's projects only — there is no cross-profile view (decision 2026-07-13); day-to-day work happens inside `/project/:id`. On the dashboard each card can be **renamed** (name only; the path is the repo's clone location) and **archived** — a reversible hide that drops it into a collapsed "Archived" disclosure at the bottom while retaining every session, worktree, and bit of data (reopening restores it). Both actions are on hover buttons in the card's corner and on a right-click menu. Cards are **drag-reorderable**, newest-first until dragged, with the order persisted per profile in `profileSettings.projectOrder` (the same order the cross-project session sidebar inherits — §12). New sessions are always created within a project, which supplies the profile, repo, and defaults — so the new-session modal reduces to account → base branch (the branch/directory toggles seeded from `profileSettings.sessionDefaults`, both kinds defaulting to the shared base-branch directory since 2026-08-03; ticking separate-branch shows the Branch field, unticked warns — §4 Relaxed isolation) → title/prompt. **Which** project is retargetable in the modal itself (decision 2026-08-03), seeded from the gesture that opened it — the workspace's current project, or the one whose session-sidebar header was right-clicked ("New agent/terminal in this project"). It is deliberately not a peer of the pickers below it: the project name sits inside the modal's description sentence as a dim inline dropdown that brightens on hover, with no chevron-and-field chrome, and degrades to plain text when the profile has only one project — the seed is nearly always right, so it should read as a fact you can change rather than another decision to make (§12). Switching it re-seeds the branch state, since a base branch and a directory to join belong to a repository. Session branches default to `<branch_prefix><slug(title)>` (or the session's short id when untitled); on collision with any existing branch, append `-2`, `-3`, … — never fail session creation on a branch-name clash.

**Homescreen actions and the home terminal.** Two action tiles sit in the projects grid, on the same surface as the cards: **Open project** opens the new-project dialogue — its path field autocompletes over `GET /api/fs/dirs`, and a **"browse…" folder picker** walks the same endpoint graphically (up-navigation, git repositories flagged, every row descending on click), so picking a folder works identically for local and SSH hosts, where an OS file dialog could only ever see the client machine. The path input is the picker's **single source of truth**: every navigation writes the browsed directory into the field (no duplicate path line in the picker), and "choose" fills the project NAME from the chosen directory's basename and closes the picker — and **Open terminal** opens a plain shell in the daemon host's home directory — the place to clone a repository before opening it as a project. The shell renders in a bottom pane that exists on the dashboard alone, with no tab strip or heading. It is one-at-a-time: the PTY lives on the daemon's project-less `home` stream (§6), and while it is live any spawn request returns the live shell — reopening the pane (or opening it from another window, or after a reload) reattaches with scrollback replay rather than stacking a second shell. While the pane is open the tile reads **Close terminal**, which ends the shell (`kill-shell`); the pane also closes itself when the shell exits.

**Reload semantics.** Workspace layout is a two-tier model (decision 2026-07-14, refining the earlier single-row design below). Each **window** keeps its own working set in `sessionStorage` (`puddle.ws.<profile>`) — reloading that window restores it exactly, independent of any other open window, and windows never live-sync while open. The profile's row in `profile_states` — layout follows identity alone, not browser or project (decision 2026-07-17, replacing the earlier `(project, profile)` keying: the centre editor area is ONE surface shared across the profile's projects — the cross-project sidebar opens other projects' sessions as tabs in the same tree, so a per-project snapshot made the layout appear and vanish with the URL; before that, 2026-07-13 replaced client-uuid keying so layouts survive tunnel-port and machine changes) — remains the **seed for fresh windows**: a window with no sessionStorage entry yet (a new tab, a fresh browser, a different machine or tunnel port) loads from that row instead. The snapshot JSON holds: the **tiling tree** (`layout_tree`) — the recursive Split/Leaf tree of editor + terminal tabs and per-split pane sizes (the single source of truth for what is open and where); the explorer pin, the left-navigator mode (`sidebar_mode`), the URL-bound active session, and the shell sidebar sizes. The legacy `session_tabs`/`editor_tabs`/`active_editor_tab` fields remain in the schema for migration (`layout_tree` null ⇒ rebuild from them). **Project-based layout** (11.2, the per-browser `projectBasedLayout` setting — §12, ON by default since 2026-08-04) rides the SAME snapshot. Terminals held by the OTHER projects' slices retain **stable portal ownership** while parked and detached from their PTYs: the keep-alive host takes the union of the live tree's terminals and those slices' (`parkedTerminalSessions`). Recent viewers stay warm across project switches; older eligible viewers use the local transcript retention policy in §6 (2026-11-05). This preserves immediate move continuity without retaining an xterm buffer for every previously visited tab. Profile-wide layout never had it: one tree holds every tab. The snapshot's shape: `project_layouts` maps project id → { `layout_tree`, `active_session`, `layout_ref` } and `layout_mode` stamps which keying the layouts were last maintained under (absent/`profile` ⇒ the top-level keys are live); `layout_ref` (12.2, also a top-level key for profile mode) names the saved layout the live one derives from (§11 Layouts). The web converts exactly once whenever the setting disagrees with the stamp: profile → project **splits** the shared tree into per-project slices, each keeping the tree's structure with only that project's tabs (untitled drafts follow the open project; a slice already stored is never overwritten — the shard fills only projects without one, §11 Layouts); project → profile **unions** the slices back — structures side by side in a row split, tabs deduplicated in sidebar project order with the current project first — and clears them. **Node ids are unique within a tree** and the transition must keep them so (decision 2026-08-03): every shard is re-id'd, the union deduplicates, and a tree that loads with repeated ids is repaired (and the repair persisted) before it renders. Ids are the tiling area's React keys and its resizable-panel ids, so a repeat both aliases panes (`findLeaf` reaches only the first) and trips the panel library's "Panel ids must be unique" invariant during render — which, with no error boundary, blanked every window that loaded such a snapshot in v0.0.22–v0.0.23. Everything else (shell sizes, sidebar modes, explorer pin, `session_order`) stays profile-wide in both modes, and the two-tier persistence above carries the slices unchanged. Consequences:

- A window's own reload or browser restart restores that exact window, from its own sessionStorage entry.
- A brand-new window has no sessionStorage entry, so it seeds from the profile's most recently written server row.
- Either restore path reattaches terminals via their daemon-persisted screen and scrollback snapshots (they look untouched), reopens editor tabs, and surfaces any `interrupted` or `exited` session — agent and plain terminal alike — with a plain Resume button overlaid at the bottom-right of its own pane (no verbose banner; the tab's status glyph tells the story) — restoring is not just layout numbers, it's the working session as it looked before.
- Navigating between projects does NOT switch workspaces (under the default profile-based layout): the same tree stays put, and only the URL-bound session (and with it the left sidebar's binding) changes. Under project-based layout it DOES: each project swaps in its own slice, restoring that project's stored active session. Restore-on-open prunes dead tabs against the daemon's full session list — never one project's — and only auto-navigates to the stored active session when it belongs to the project being opened.
- **A switch never unmounts the workspace** (decision 2026-08-04). The project-detail query keeps the previous project's data while the next is in flight, so the loading gate — which now needs only the project ROW, already in hand from the profile's project list — no longer replaces the whole shell for the length of a fetch. That flash tore down every open terminal (they re-attach, but the viewport was lost) and pulled the sidebar out from under a double-click mid-gesture. Anything that must be about the project in the URL waits for that project's own detail; the stale row is used only for the PROFILE, which a within-profile switch does not change.
- **Opening another project's session from the cross-project sidebar** (§12) always does two things: its project becomes the active one (the URL follows), and the session opens in **that project's** layout — as a preview on a single click, pinned on a double click or a drag, exactly as it would in its own project. Under project-based layout the two projects are different trees, so the gesture cannot open the tab where it was made: it navigates and the arriving layout opens it. A session **dragged** out of another project's group therefore lands in that project's layout rather than being filed under this one (which would have hidden it behind the very switch the drag triggers); the dropped POSITION is the one thing that cannot follow, since it names a pane in a tree that is not the destination's. Under the profile-based layout there is one shared tree, so a drop lands exactly where it was made and the URL simply follows.
- Any number of your own windows each keep an independent working set — they never live-sync — and the server row is updated debounced (~2 s), last-writer-wins, by whichever window changed layout most recently; this only affects what a _future_ fresh window seeds from, never an already-open one.
- A coworker works under their own profile and their own row. A fresh profile starts with a fresh workspace — there is no cross-profile seeding (a profile-wide layout is personal in a way a single project's wasn't), and nobody can clobber yours.
- Stale rows (not updated in 90 days) are garbage-collected by the daemon.

Transient focus (which tab is active right now) stays local to the window.

Dirty editor buffers persist independently in the browser's IndexedDB (`puddle-drafts`, debounced ~1 s) and are restored on reload; drafts are per-browser only, never synced through the daemon or between windows. A cached draft whose text already equals the file is retired as a no-op regardless of mtime: an editor, formatter, or Git operation can rewrite identical bytes, and timestamp movement alone must not manufacture an unsaved-draft warning on every project return.

**A refused save is reconciled, not just refused** (decision 2026-08-05, interaction revised 2026-08-11). The daemon rejects a write whose `expected_mtime_ms` no longer matches the file (409 `stale_file`), which in practice means the agent edited it while it was open here. Nothing is written, the buffer remains editable, and a dismissable **File changed on disk** notification offers one action: **Compare**. An unresolved conflict re-offers that notification whenever its file tab becomes the logically focused tab after having been left; dismissing it stands while the tab remains focused. Choosing Compare synchronously locks the shared buffer across source, rendered-preview, and editable-diff views, then reads the current disk version. The lock remains through loading and until Monaco has mounted the side-by-side comparison; a failed or non-text read stays locked behind an explicit Retry rather than falling back to editing. The comparison shows the **file on disk** read-only on the left against **the buffer** on the right; only after both models mount does the right side become editable, so copying a hunk across is an ordinary edit. A reconciled save expects the DISK version's mtime rather than the stale load mtime, allowing the merge to land. The two decisive answers live in the comparison (take the disk version, keep mine), and the conflict clears on reload, overwrite, or a merged save.

**⌘S also works outside Monaco.** The save action is `editor: true` — bound on the editor instance, which is right while the caret is in it and wrong the moment the focused pane's tab has no Monaco to bind (a rendered preview) or has one that has not been clicked into (a pane focused by its tab chip); ⌘S then fell through to the browser's Save Page. So each mounted editor body publishes its buffer's save in a small registry keyed by buffer identity (`save-registry.ts`), and the shell dispatcher (§11) sends `editor.save` to the FOCUSED pane's active tab whenever the caret is outside a `.monaco-editor`. A source tab and a preview tab of one file share one buffer and therefore one save, so whichever is mounted answers.

Any profile can view/attach any session (trusted shared box); the UI shows the owning profile on each project and session card.

## 12. Design system

Puddle's UI must read as a polished, intentional developer cockpit — dense, calm, and visually coherent — not a scaffold of framework defaults. `HUMANS.md` at the repo root is the human-authored design brief (minimalism, rounded floating islands with empty gutters, fill-shift responsiveness, and optional continuity-preserving motion) and overrides this section wherever they conflict.

- **Shared island system** (2026-11-05): `components/ui/recipes.ts` owns field,
  compact action, menu and overlay surfaces. `--ui-*` geometry scales with the UI
  font size; touch controls retain larger targets. Menus, submenus, selects,
  tooltips and popovers share fade/scale motion and rounded, outlined surfaces;
  toasts use the same radius and shadow. Use `--nav-selection` and
  `--nav-selection-ink` for persistent gold navigation, independently of gold
  foreground glyphs. Check selected text, action/hover and danger fill pairs at
  4.5:1, including tray surfaces. Application chrome must not introduce literal
  palettes; the token guard scans source as well as theme completeness.
- **Interaction continuity**: selection identities belong to a workspace-scoped
  tray provider, not accessible labels. Remounts retain the visible marker position,
  including interrupted motion; sidebar counterparts handle orientation changes.
  Hover stays beneath selection and content. Floating tab actions are available on
  keyboard focus and touch as well as hover. Shared resize feedback outlines the
  facing island edges at 3px in the existing border colour, fading around corners;
  gutters stay empty. Internal Changes/History and archive handles also support
  arrow keys (Shift for a larger step), Home and End.
- **Reduced animation and motion**: the client setting and OS preference both
  disable decorative CSS motion. Enabling reduction cancels an active sidebar
  transition and its live-editor resize. It does not suspend functional rendering.
- **Header identity**: the hostname uses the standard primary text colour, independently of project colour.
  Explicit project colour applies to the command-palette project label and shortcut;
  profile glyph/name retain the profile's own colour.
- **Standalone native prompts**: the desktop build embeds the cockpit colour tokens
  and shared prompt geometry into its connection, host-picker and SSH-authentication
  pages without external resources or a broader CSP. The last saved cockpit theme
  is mirrored to `desktop-appearance.json` under the client home for subsequent
  prompts; when unavailable or set to system, prompts follow the OS. Only registered
  cockpit main frames can report that bounded preference.

- **Stack**: Tailwind CSS v4 + **shadcn/ui** (Radix primitives, generated into `packages/web/src/components/ui/` and treated as owned code to restyle, not a dependency), `lucide-react` icons, `cmdk` command palette (⌘K: switch project/session, new session, open any host file/directory path, insert prompt, switch theme, open settings), `sonner` for toasts, `react-resizable-panels` for the workspace layout. No monolithic kits (MUI, Ant): they resist theming and read as generic enterprise chrome.

- **Two-layer token architecture** in `packages/web/src/styles/tokens.css`:
  1. _Primitive palette_: theme-independent colour ramps derived from the five core colours below.
  2. _Semantic tokens_: the only names components may use — `--bg-base`, `--bg-surface`, `--bg-elevated`, `--border`, `--text-primary/-secondary/-muted/-gold`, `--accent`, `--accent-hover`, `--action`, `--action-hover`, `--action-ink`, `--nav-selection`, `--nav-selection-ink`, `--danger-ink`, `--bg-tray`, `--focus-ring`, `--danger`, `--success`, `--warning`, `--status-running/-waiting/-interrupted/-idle/-terminal`, `--selection`, `--diff-added`, `--diff-removed`, plus the 16 `--ansi-*` terminal colours. A theme is one `[data-theme="<name>"]` block assigning primitives to **every** semantic token. Because the semantic tokens exist ONLY inside those blocks, the theme has to be on `<html>` before the first paint: an inline script in `index.html` sets `data-theme` (and `data-density`, and the `--ui-font-size` rem base) from `localStorage` in `<head>` — the app's own `initTheme`/`initClientSettings` still run and remain authoritative, but they are in a deferred module, and measurement (2026-08-04) showed the browser painting one unthemed frame — no ground colour at all, i.e. white — before it executed, on every load.

  The Tailwind theme maps utilities onto semantic tokens; the xterm.js theme object and the Monaco theme are **generated at runtime from the computed CSS variables**, so adding a theme is one CSS block plus one entry in a theme registry — zero TypeScript changes. A CI script asserts each theme block defines the complete semantic set and that text pairings pass WCAG AA (4.5:1 body, 3:1 large/UI elements). Terminal, editor, and chrome must visibly share one palette — a stock-dark xterm next to Monaco's default `vs-dark` inside a differently-dark app is forbidden.

  The file explorer uses coloured **Material Icon Theme** SVG artwork bundled with its MIT licence and pinned provenance under `public/file-icons/material/`. These third-party assets retain their original colours; application colours remain in tokens.css. The explorer's `--explorer-folder`, `--explorer-foreground`, `--explorer-selection` and `--explorer-hover` tokens provide theme-coloured folders, neutral text and rounded selection/hover fills in both themes. Git status colours decorate names, badges and folder icons independently of file-type colours (decision 2026-11-04).

  Monaco's ordinary-editor dirty-diff gutter follows the same semantic palette: additions use `--success`, modifications `--accent`, and deletion triangles `--danger`. These are line decorations in a reserved lane, not glyph-margin icons, and therefore remain legible and consistent in both shipped themes without introducing component-local colours.

- **Core palette** (the brand; hue is preserved within each ramp, only lightness/saturation step):

  ```css
  --altitude-blue: #7dadff; /* primary accent family */
  --krypton-green: #8be8b3; /* success / waiting family */
  --quiet-khaki: #ddb28c; /* warm neutral / attention / running family */
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
  | `--text-muted`                      | `#7E93B3` | `#6B6B6B` |
  | `--text-gold`                       | `#DDB28C` | `#8A7663` |
  | `--accent` / `--focus-ring`         | `#7DADFF` | `#2E6BD6` |
  | `--accent-hover`                    | `#A7C7FF` | `#4A86E8` |
  | `--action` (primary-button fill)    | `#EAF1FB` | `#001C3D` |
  | `--action-hover`                    | `#B9C9E0` | `#0A2B52` |
  | `--action-ink` (text on the fill)   | `#001C3D` | `#FFFFFF` |
  | `--success`                         | `#8BE8B3` | `#157A50` |
  | `--warning`                         | `#F0B36E` | `#A9743D` |
  | `--status-running`                  | `#F0B36E` | `#A9743D` |
  | `--status-waiting`                  | `#8BE8B3` | `#157A50` |
  | `--status-interrupted` / `--danger` | `#F2957C` | `#C2472E` |
  | `--status-idle`                     | `#7E93B3` | `#6B6B6B` |
  | `--status-terminal`                 | `#7DADFF` | `#2E6BD6` |

  Primary actions (buttons, checked toggles) are **ink, not accent**: mist on the dark theme, storm navy on the light — the accent blue is reserved for links, focus, and selection. The dark theme is storm-navy ground with the pastel family as light; the light theme is a white ground (HUMANS.md: white, not beige) with navy ink for primary and secondary text and a neutral grey for muted (the earlier golden bark read as distracting on hints/metadata), keeping the deep accent steps. The warm gold survives as a deliberate accent — `--text-gold` (gold in both themes) for the sidebar's glyph icons and its ALL-CAPS section headings, plus the status-running colour — while prose, paths, and metadata stay grey. Session status inverts the naive mapping (decision 2026-07-29): a **running** agent shows **amber** (work in motion, eyes-off) and **waiting_input** shows **green** (ready for you); git badges and caution copy use `--success`/`--warning`, which keep the conventional hues. Light `--success`/`--status-waiting` use a derived deeper krypton step (`#157A50`) because `#1FA26B` misses the 3:1 AA floor on the elevated ground.

- **Switches**: keep the visible track at 2.25 × 1.25 rem inside the button; mobile touch targets may grow without stretching the track or thumb. Labels remain tappable and native switch keyboard/disabled semantics are retained.

- **Cursor packages**: Appearance offers `System` (the default browser/OS pointer, interactive hand, and text caret), `Rangefinder` (a 27 px tessellated microprism spot, shrinking to 11.7 px over interactive targets), `Drafting` (a four-tick 24 px precision crosshair, contracting to an accent-coloured 14 px crosshair over interactive targets), and `Invert` (a 14 px contrast-inverting ring, becoming an 8 px dot over interactive targets). Every custom package collapses into a type-sized caret over selectable text, and the whole Monaco surface — lines, gutters and blank trailing space — is always a caret for every package. The choice is a per-browser client setting and travels with the Appearance sync group. Custom renderers replace cursors only for fine pointers; touch and embedded documents keep their native behaviour. Their renderer is portalled at document level so full-screen dialog overlays, including the command palette's side gutters, retain the selected package rather than exposing a native pointer. Pointer bursts apply their latest position in one on-demand animation frame. Role and caret-size checks are reused for the same target, invalidating on relevant ancestor/text/style changes, font completion, focus, scroll and resize. No frame loop runs while idle, and hiding or changing packages cancels queued work. Visual effects and reduced-motion rules remain shared with the existing appearance system.

- **Terminal colour queries**: the PTY owner (`puddler` for independent runtimes, the daemon for its remaining terminals) answers the OSC 10 (foreground) and OSC 11 (background) dynamic-colour queries (14.0 answered them in the web terminal — but an auto-theming agent samples the background AT SPAWN, usually before any viewer has attached, so the viewer-side answer arrived for nobody and e.g. Claude Code's `theme: auto` fell back to dark whatever the app theme; fixed 2026-08-06). Clients report their resolved `--text-primary` / `--bg-base` over the WS (`theme`, protocol 14.1 — after auth on every connect and again on theme switches; last report wins, matching the stdin rule), and the PTY layer scans output for the query sequences (chunk-boundary-safe, `pty/terminal-theme.ts`) and replies `rgb:RRRR/GGGG/BBBB`. Against a ≥14.1 daemon the web terminal consumes OSC 10/11 queries without replying, suppressing xterm 6’s built-in responder so the agent receives exactly one answer even with multiple viewers; against an older daemon it keeps viewer-side answering. Both paths suppress historical queries during replay and leave colour-setting sequences to xterm. A theme switch still takes effect on the next agent start/resume — a running agent that already sampled the background does not re-query.

- **ANSI mapping rule**: dark theme maps the pastel depth of each hue (red→`#F2957C`, green→`#8BE8B3`, yellow→`#F0B36E`, blue→`#7DADFF`, magenta→`#B9A3F2`, cyan→`#7FD6DC`, fg→`#EAF1FB`) over `--bg-base`; the light theme maps each hue's deep step (`#C2472E`, `#1FA26B`, `#A9743D`, `#2E6BD6`, …) so agent output stays legible on the white ground. Brights are one lightness step up. UI accents and terminal output are thereby the same family by construction. Every xterm viewer also sets `minimumContrastRatio: 4.5`, letting xterm correct a foreground that an agent places over an incompatible background while retaining deliberate dim text. This covers TUIs that cache their startup OSC 10/11 result and keep a dark input background after Puddle switches to light (or the reverse) without rewriting their terminal stream.

- **Type**: one UI face and one mono face, chosen deliberately and **self-hosted** (hosts and clients may be offline; no font CDNs). Mono is the workhorse of identity: session titles, branches, the powering account's label, paths, ports, and statuses are all set in mono. Set a real type scale.

  Monaco refreshes its cached font measurements after the initial document fonts settle and after subsequent font loads. Editors and diff views remain usable with fallback fonts during loading; bracket highlights, selections and carets realign when the self-hosted face replaces them.

- **Status is carried by colour, not motion.** A session's state reads from the colour of its indicator alone: `--status-running` amber, `--status-waiting` green, `--status-interrupted` ember, `--status-idle` grey, and `--status-terminal` blue for a shell so a terminal reads apart from an agent at a glance; `waiting_input` is additionally mirrored in the tab title/favicon, and a `stale_running` session is faded to 45%. **Where a row has room for the agent's brand mark — the expanded sidebar rows and the tiling tab chips — the mark IS the indicator** (`status-glyph`), rather than a dot beside a mark saying the same thing twice; a terminal shows a terminal glyph. The mark is now the **only** indicator — the collapsed session rail was the last place a bare dot survived and it shows the glyph too (2026-08-03), so `status-dot` no longer exists.

  **There are no status animations** (decision 2026-08-03). The interface previously rippled a running dot and pulsed a waiting one — its one animated flourish — bounded to ~30 s and ~1 min so the compositor eventually settled. Both are gone: the colour already carried the state, the motion only repeated it, and every status change across every visible session was paying for frames to say so. A ring drawn around a brand mark also reads as a border badge rather than a ripple, which HUMANS.md rules out. Consequently there is nothing for `prefers-reduced-motion` to degrade and **no reduced-motion client setting** — it existed solely to switch these off. Everything in the interface is now instant or a ≤150 ms fade.

- **Density**: compact paddings, information-dense lists, tabular numerals for ports/counts; generosity is reserved for primary actions and empty states. The **Density setting** (client scope, default compact) is real since 2026-08-03: the root carries `data-density`, and `compact:` utilities (app.css @custom-variant) tighten the sidebars' vertical rhythm — session rows and rail dots close up, file-tree rows drop to h-5 — while comfortable keeps the roomier baseline.
- **A render throw never empties the window** (decision 2026-08-03). React unmounts any tree it cannot render, so before this an exception in render — or in a commit-phase effect — left a white page with no message and no way back; that, not the bugs themselves, is what made v0.0.22's hook-count change and v0.0.23's duplicate pane ids look catastrophic. `components/error-boundary.tsx` is mounted twice: around the ROUTED view (keyed by pathname, so a crash in a workspace leaves the top bar alive and navigating away clears it without a reload) and at the ROOT (the shell, providers, token gate). It states what stopped rendering, shows the error message verbatim, says plainly that sessions and worktrees are on the daemon and the layout is saved — a blank window taught users otherwise — and offers Try again / Reload. It logs the error and component stack to the console: a boundary makes a failure legible, it must never make one quiet.
- **Disclosure arrows**: `components/ui/disclosure.tsx` retains native details/summary keyboard and expanded-state semantics, hides browser triangle markers, and uses the same right/down Lucide chevron as other Puddle controls. Settings, compiler-output notices, remote account controls and mobile session actions share this primitive.
- **Honest form fields** (decision 2026-08-03): an optional field whose empty value would be silently substituted is **prefilled with that effective default** (profile branch prefix, project abbreviation, session base branch, tab-title template) — the field always shows what will actually be stored. Where empty genuinely means something (no prefix, the repository default, the clone’s current branch, the hostname), the placeholder or description says exactly that, never a value that would not apply. Numeric settings commit on blur/Enter (`NumberField`), never per keystroke — a half-typed value must not apply mid-edit — reverting on empty/invalid input and clamping to their range.

- **Narrow viewports (phones)**: the local cockpit preserves its desktop layout tree and uses overlays for its navigator/session list. Phone selection never flattens or saves the desktop tree; crossing the breakpoint retains the xterm DOM and tab-local drafts. Hidden terminals send no resizes. Controls revealed on hover (tab closes, row menus, card actions) are always visible on coarse-pointer devices (`pointer-coarse:` variants).

- **Public setup guide**: deployed remote-app builds serve `/guide` (and `/guide/`) without authentication or relay access; old `/faq` paths redirect to `/guide`, preserving query strings and fragments. `packages/web/src/features/guide/guide.md` owns the editable prose, commands and table of contents; `{{APP_ORIGIN}}` is replaced with the current application origin for installer URLs. Markdown headings receive lowercase, punctuation-free ids with spaces replaced by hyphens and numeric suffixes for duplicates. GitHub-style `NOTE`/`TIP`/`IMPORTANT`/`WARNING`/`CAUTION` alerts use the shared preview styling, including within lists. Raw HTML is disabled and custom alert titles are escaped. The page uses shared typography/colour tokens, a readable mobile layout and a return link to the app. The line “For setup or upgrade instructions, see Guide.” links to `/guide` below sign-in buttons and above the signed-in host/project list, including its empty state. Content covers CLI installation channels, component dependencies and lifecycle, local/SSH daemon management, desktop platform differences, upgrade/version selection and removal/data retention.

- **Remote mobile workspace**: a minimalist distillation of the cockpit, sharing its project-card content/surface, session glyphs, new-agent/new-terminal dialogue and UI primitives. The homescreen shows the Puddle mark and **Puddle Remote**, followed directly by project cards grouped by host, separated by quiet dividers. Each host uses the shared disclosure chevron to collapse its projects; catalogue connections read each approved host directly without installing the workspace transport or attaching PTYs. Unpaired/offline hosts have an explicit empty state. Settings contains appearance, account security, host disconnection/reconnection and pairing management. Disconnect closes this browser's viewer and suppresses catalogue reconnection for the current visit; agents continue on the host. Pairing and desktop registration use the shared dialogues; host identity is an optional disclosure before pairing, while the exact pending browser identity stays visible for approval. Mobile and desktop browser lists share compact account-style cards with a name, status and revoke icon. Approved browser identity/expiry details expand on demand; pending identities remain visible for comparison before approval. Desktop wraps the cards in an initially collapsed Connected browsers disclosure. Both lists omit revoked records; the host retains their audit history.

  The workspace shows a muted **host/project** breadcrumb that returns directly to the home cards, and an initially collapsed session rail on the left. Its single toolbar shows the current terminal title with an embedded session-details button, followed by **Files**. Tapping the title opens the shared Puddle dropdown with session glyphs, the current selection and all non-archived agent/terminal sessions in the active project. In Files, the same row holds parent/back navigation, the path, changes, refresh and a computer icon returning to terminals; the current view has no redundant selector button. Home cards and rail project labels follow each profile's saved desktop project order; rail sessions and the title dropdown follow its saved session order, using the same newest-first fallback for unsorted entries.

  Only the active project's non-archived sessions appear; other project labels remain tappable to switch projects. Tap a glyph to select its terminal, hold it (or use its context menu / expanded detail button) for session information, rename, resume/stop or archiving. The rail expands from the left over the content; compact new agent/terminal controls use the desktop agent and terminal icons at its top and the archive browser stays at the bottom. Its controls use the desktop gold token and surface/hover treatments, while session glyphs retain their status colours. The collapsed rail gives five-character monospaced project labels enough width without ellipses, and its toggle shares the file/title toolbar height so their centres align. Extra shell creation is absent from session details; the rail creates standalone terminals through the shared new-session dialogue. Terminal ownership survives view/project/session switches, with older offscreen viewers following §6’s local transcript retention policy; visible disconnected terminals remain mounted. Terminal selection and drafts are scoped to service/account/host.

  Files follows the active worktree, falling back to the project's repository when there is no session. Tapping its path or filename opens a dialogue prefilled with that exact directory/file path. The existing resolver, addressed through its directory target and validated `root`, accepts files and directories, absolute or `~/` paths, and paths relative to the current browse root. Resolution errors leave the current view intact. A resolved file opens the inert viewer and binds its containing directory for Back; a directory opens the tree. Single taps select files; double taps/clicks (or Enter / the selected row's view button) open the viewer, whose back button returns to the same directory. Holding a file row opens the shared context menu with Download; scrolling cancels the hold, and release does not open the file. Remote downloads preserve the filename and bytes through the existing bounded `preview-asset` route (8 MiB per file); directories and unresolved links have no download action. A visible pending notice covers the read, and leaving the row/host or changing connection generation cancels the browser save. Local mobile downloads use the existing authenticated download route. File content uses native DOM text selection, extends held drags across the visible text, and shares the explicit Copy action with terminals; ordinary swipes retain native scrolling. Change review remains available inside Files, with no nested Changes/Files/Refresh toolbar or second file browser. Each diff hunk stacks Before above After, with real line numbers, addition/deletion counts, theme-derived line fills and stronger changed-word highlights. Diff calculation and word highlighting are time-bounded; reviews above 5,000 diff lines fall back to the full Before/After text views. Added, deleted, renamed, binary and missing-final-newline files retain explicit handling. Source and change review remain escaped, selectable text. A file-view **eye toggle** switches Markdown (`md`/`markdown`/`mdown`), HTML (`html`/`htm`) and the desktop image/audio/video/PDF formats into their shared renderers; each newly opened file starts in source, while a tapped Markdown file link opens its target in preview when supported. Preview state stays local, with no editor buffers, locking, following or scroll synchronisation. Refresh reloads source and assets. Markdown keeps sanitisation, maths and Mermaid; HTML supports inline and local JavaScript and styles. Remote assets use `GET /preview-asset` (21.1): each file is capped at 8 MiB before base64, streamed with a second size check, and returned as bounded JSON under the existing host lease and encrypted response limit. Two concurrent asset reads leave request capacity for the workspace; queued reads cannot cross hosts. Relative/root-relative references use the same validated browse root as the source. As on desktop, nested CSS URLs and JavaScript imports are not recursively resolved. Raw media/download endpoints, directory archives, editing and Git mutations remain unavailable remotely.

  HTML runs in an `allow-scripts` iframe **without `allow-same-origin`**, loaded from the static `/preview.html` shell. Its response CSP enforces the sandbox even on direct navigation and permits document scripts/styles and data assets; only its parent can provide a document through its one-use message listener. No credentials or request capability enter the frame. The main app retains `script-src 'self'`; its CSP permits the shell and media blobs without allowing inline application scripts. The remote app deployment, daemon (21.1) and host connector must be updated for previews; the toggle is hidden on older daemons. Remote protocol remains 3.

  Tap the terminal to type directly into xterm; taps reach xterm unchanged, so applications with mouse reporting receive them (for example to place their own caret). On iOS, xterm's hidden textarea holds five rows of blank padding with the caret in the middle, never typed text. The spacebar trackpad requires a displacement of two native caret steps in a direction before sending one arrow key (honouring application cursor mode and one-shot modifiers) and recentring. Smaller movements stay within the padding, so reversing cancels them naturally; row changes take priority over columns, and larger jumps still send at most one arrow. Typing, key release, focus changes and composition reset partial movement, and inactive terminals recentre without sending input. Keys keep xterm's handling; handled key events cancel native insertion, including keypress-only spaces and capital letters, so the beforeinput fallback cannot send them twice. Keyless insertions (predictions, dictation, keyless deletion/return) and IME commits are forwarded directly so they cannot edit the padding, and are dropped while the terminal is inactive. Autocorrection stays off. Other platforms keep xterm's input unchanged. A per-terminal bottom strip provides an image picker, Escape, Tab, arrows, Enter, Ctrl-C and one-shot Control/Option/Shift modifiers labelled with the Mac symbols ⌃/⌥/⇧, retaining full accessible names and pressed-state highlighting. Strip keys use a compact 2.25rem minimum width and 0.375rem horizontal padding, retaining their 2.75rem minimum height. Tap a strip modifier, then the target key; the software keyboard’s Shift state does not modify a separate strip button. Shift+Left sends `CSI 1;2D`, Shift+Tab sends back-tab, and Shift+Enter uses CSI-u. Modifiers combine, apply to normal and application-cursor arrows (including the iOS trackpad), and clear after a key; device replies and mouse reports leave them pending. Unmodified strip arrows honour the terminal’s current application-cursor mode; touch key controls activate once on touch release and use hardware-equivalent sequences; any tap on the strip — a key, a gap between keys, a disabled or slightly moved key — suppresses Safari's synthetic click and focuses the terminal, so it keeps (or raises) the keyboard. The image picker and composer toggle keep their own click. Horizontal drags scroll the strip without sending a key. The image picker replaces the keyboard button and shares desktop clipboard image paste (§7): upload to the placement's `.puddle/pastes/`, then insert its relative path, never submitting, into whichever input was used last: the optional composer's draft (at its caret) when it is open and was focused after the terminal, otherwise the terminal. Remote insertion is acknowledged and never replayed. Remote uploads use the capability-detected connector-local `POST /api/worktrees/:sid/paste-upload` (§6), preserving original image bytes up to 4 MiB. Originals up to 20 MiB are accepted; larger PNG/JPEG/WebP images are recompressed/resized in the browser to fit 4 MiB with a visible notice, while larger GIFs are rejected to preserve animation. The picker shows acknowledged upload progress and an explicit cancel action, and cancels when its terminal changes or disconnects. Cancellation prevents path insertion; a final save already dispatched may leave a completed file. Uploads and insertion never continue across connection generations. Older connectors keep legacy pastes up to approximately 191 KiB and show an upgrade message for larger images. Update the host connector and static app for the larger limit; ordinary requests retain the 256 KiB cap. An optional multiline composer retains unsent drafts and uses xterm's bracketed-paste encoder with acknowledged delivery. VisualViewport height/offset and safe-area sizing keep the strip above the keyboard and shared dialogues within the visible area. Real iOS/Android keyboard behaviour remains a physical-device acceptance check.

  The remote document stays fixed to the visible viewport; the dashboard, files, session rail and dialogues own their native scrolling without chaining to the page. The shared terminal translates quick single-finger drags into normal-buffer scrollback or xterm-encoded wheel/alternate-screen input when the application owns scrolling. A held finger selects a word locally; dragging then extends the selection across rows, with edge scrolling through normal-buffer history. A shared Copy action writes the selected text only after a tap; selecting never sends agent mouse input, copies automatically or opens the keyboard. The same terminal menu offers Paste, including when holding an empty cell. Paste reads clipboard text only on an explicit tap, focuses the terminal, and uses xterm’s existing newline/bracketed-paste encoder without adding Enter or applying touch modifiers. Remote delivery is acknowledged without retries; a host, connection generation or active terminal change while clipboard permission is pending cancels insertion. Clipboard denial leaves the menu available with a visible message. File selection retains Copy only. Swipe distance follows terminal row height, swipes never focus the keyboard or become clicks, and pinch zoom remains available. Touch scrolling supersedes pending resize-position restoration just like a mouse wheel.

- **Quality floor**: visible keyboard focus everywhere (`--focus-ring`); session tabs, palette, and explorer fully keyboard-navigable; empty states direct action ("No sessions yet — press ⌘K to start one"); error copy states cause and fix, never apologises vaguely.

- **Window title**: a project workspace normally reads `<project> — <host>`; while agents wait it reads `● <n> waiting — <project> (<host>)`. Waiting status never replaces the host label, because similarly named projects can be open against different machines.

### Single-tab pane presentation

A pane with one tab uses its full content area without a title strip. Its thin top
edge retains drag, context-menu and keyboard access and shows the full file path
on hover: relative to the displayed file tree when contained within it, otherwise
absolute. Floating actions retain their own portalled tooltips. Opening or dropping
a second file preserves the first and restores the normal tab strip; subsequent
preview replacement in a multi-tab pane retains the usual preview slot behaviour.
Closing back to one tab restores the full-pane presentation. Session hover fills
slide between rows in either sidebar state, beneath content and selection, and
become immediate when reduced motion is enabled.

## 13. Repository conventions

- Monorepo (pnpm workspaces): `packages/daemon`, `packages/web`, `packages/cli`, `packages/shared` (zod schemas + WS message types shared by all three).
- Within packages, group source files by responsibility and keep feature-specific components, state and helpers together. Large features use subdirectories (for example editor buffers, notebooks and previews); their root holds composition modules. Web, daemon and CLI tests mirror feature responsibilities under `test/`, with shared fixtures in `test/helpers/`. Keep public package entry points stable and use direct internal imports. The detailed directory map lives in `CLAUDE.md`.
- TypeScript strict everywhere; vitest for tests; eslint + prettier; MIT licence.
- `CLAUDE.md` at the repo root governs agent conduct and links `CHANGELOG.md`; see those files. Archived changelogs live in `docs/changelogs/CHANGELOG-vX.Y.Z.md`.
- **Licensing rule**: this is a public MIT repo. Do not copy code from AGPL projects (e.g. claude-squad) — studying their approach to worktree/PTY edge cases is fine; verbatim or near-verbatim code is not.
- No company-, team-, or person-specific strings anywhere.

## 14. Phases and acceptance tests

Each phase must be independently verifiable before the next starts.

- **Phase 0 — scaffold.** Monorepo, CI (typecheck + test + build), CLAUDE.md/CHANGELOG.md conventions in place. AT: `pnpm build` produces daemon with embedded UI assets; CI green.
- **Phase 1 — daemon core.** Profiles/accounts/repos/projects/sessions CRUD; local-security layer (token, Host/Origin checks — §2); permissions-gate enforcement; claude-code adapter; worktree create/remove (per-repo mutex, fetch policy, onboarding preamble injection from onboarding_notes + marker-file notes sync); PTY spawn with `CLAUDE_CONFIG_DIR`; WS streaming; append-only logs; reconcile pass. AT: via curl + wscat only — two sessions on two accounts stream interleaved output; requests without the token are rejected; `skip_permissions: true` against a closed gate returns 400; `systemctl --user restart puddled` marks sessions interrupted; resume restores both conversations; logs replay; a session on a fresh worktree receives the onboarding preamble (and a hand-off session in the same worktree does not); writing `.puddle/onboarding-notes.md` updates `repos.onboarding_notes`.
- **Phase 2 — UI shell.** Design system foundation first (tokens.css with both themes + registry, CI token/contrast check, Tailwind + shadcn setup, fonts, runtime-generated xterm/Monaco themes — §12), then: project dashboard; project workspace with session tabs and live status indicators; terminal attach with replay; new-session modal (account → base branch → optional branch name; title and first prompt are given later, in the session itself); interrupted-session resume button; theme switcher; **settings panel** (all §11 sections; permissions gate with its confirm dialogue); ui_state persistence and restore-on-open (AT: open a project with three sessions and two editor tabs, kill the browser, reopen `/project/:id` — identical workspace; AT: switching theme restyles chrome, terminal, and editor together with no reload).
- **Phase 3 — files, diff, history.** Tree browser, Monaco editing, diff tab (editable modified side), history tab; file transfer (drag-in upload onto explorer folders, context-menu download with zipped folders — §8). AT: edit a file in the diff view; the agent's next `cat` of it shows the change; commit list matches `git log`; drag a file from the local desktop onto an explorer folder — it appears in the worktree; download a folder — a zip of its contents arrives.
- **Phase 4 — terminal links.** URL and file-path link providers share wrap-aware cell mapping; file paths use resolve validation and open-in-editor deep links. File-path ranges span every visual row after soft wrapping, terminal-rendered hard wrapping at the right edge, and resize reflow; resolve validation keeps inferred hard-wrap joins from lighting up unrelated text. AT: cmd+click on `src/x.ts:42` in agent output opens Monaco at line 42.
- **Phase 5 — ports.** Detection table + copyable `ssh -L`; then tier-2 proxy with WS upgrade. AT: a Vite dev server started by an agent is usable through `/proxy/...` including HMR.
- **Phase 6 — CLI.** `puddle launch` bootstrap/upgrade/tunnel/browser; `attach`, `status`, `logs`; **the serving switch**: the CLI serves the UI at a stable local origin and proxies `/api` + `/ws` (local and SSH modes alike — §2), the daemon build stops embedding web assets and its default binding moves to `127.0.0.1:7434`, and the shared protocol handshake with confirmed older-major daemon updates goes live (§6). AT: on a box with no puddle installed, one `puddle launch user@host` lands in a working cockpit at `http://localhost:7433`; `puddle launch` locally lands in the same cockpit at the same origin; against a daemon with an older protocol major, `launch` shows the interrupted-session count, asks for approval, updates it and reconnects; cancellation leaves the host untouched.
- **Phase 7 — more agents + continuation. DONE.** codex, opencode and gemini-cli adapters (gemini-cli beyond the original scope), capability matrix verified against installed versions, degradation paths exercised; cross-agent (tier-2) hand-off (AT: hand off a claude session to codex — new session in the same worktree opens with the transcript summary as its first prompt). **Tier-1 same-agent migration ships ahead of this phase** (Workstream S, on the shared conversation store): `POST /api/sessions/:id/migrate` and the "Move to account…" menu are already live for claude-code; its acceptance script is `docs/acceptance/tier1-migration.md` (AT: exhaust-simulate a claude session, migrate it to a second claude account — conversation resumes with history intact). Phase 7 extends migration to the newly added agents and adds the tier-2 hand-off.
- **Phase 8 — polish.** **Scratchpad** (right-sidebar CRUD, drag-reorder, tag/agent filter, insert-into-terminal + copy; AT: save a profile-scoped prompt and a project-A-scoped note — from project B the profile prompt shows and the project-A note does not; insert pastes into the focused terminal without submitting); waiting_input notifications (title badge + optional sound), archive/cleanup flows, log rotation (size cap from config.json), shell tabs.

## 15. Open questions (resolve during build, record decisions in CLAUDE.md)

1. ~~Exact resume/session flags for the installed codex and opencode versions.~~ **Resolved (Phase 7).** Verified against codex-cli 0.146.0, opencode 1.18.10 and @google/gemini-cli 0.53.1; every finding is pinned in the adapter header with the version checked, and the per-adapter notes in §5 are rewritten from those runs. A logged-in Codex 0.146.0 run on 2026-08-03 also resolved its status regex: the idle composer is `› … <model> · <directory>`, not `? for shortcuts`. The remaining live-only questions — OpenCode and Gemini CLI status regexes, whether Codex honours its bypass flag on resume (openai/codex#9144), and whether Gemini's `--resume` accepts a UUID as well as an index — are tracked in `docs/acceptance/phase-7-agents.md`.
2. ~~Session-file portability between accounts (tier-1 migration).~~ **Resolved (Workstream S).** For claude-code no file moves at all: the conversation lives in the profile's shared store and every account reads it through a symlink, so migration is "resume under the other account's config". Verified against Claude Code **2.1.209** that `--resume` reads a conversation through a symlinked `projects/<dir>` and tolerates missing `todos/` (per-account, does not travel). The `migrateSession` copy-and-rollback hook remains the specified fallback for agents that can't share state; the full two-account end-to-end flow (adopt under A, resume under B with B's real credentials) is the acceptance script `docs/acceptance/tier1-migration.md`.
3. Whether `claude --session-id` is accepted by the currently installed Claude Code version; if not, fall back to post-launch discovery of the newest JSONL in `<config_dir>/projects/<cwd>/`.
4. ~~systemd user-session availability on the target box (`loginctl enable-linger`); confirm the fallback supervisor path works.~~ **Resolved (2026-08-13).** The installer prefers a working systemd user manager and otherwise records launchd/nohup/none. An SSH launch whose recorded nohup child is dead holds `puddled` in a cockpit-owned exec channel and stops that daemon on close. Independent host-session owners may survive or be reaped by host policy; reconnection adopts survivors and reconciles ended owners using the host auto-resume setting. A live or supervised daemon is never joined by the fallback.
5. ~~Proxy base-path limitation: decide whether to attempt HTML rewriting (probably not for v1) or document the `ssh -L` fallback per port.~~ **Resolved (2026-07-14): no HTML rewriting — referer recovery instead.** The cockpit origin 307-redirects any non-`/proxy` request whose `Referer` is a proxied page back under that page's `/proxy/<sid>/<port>` prefix (see §9 tier-2 caveat (c)), which fixes absolute asset paths and absolute `fetch()` calls without touching response bodies. Residue: WS handshakes and `no-referrer` policies carry no Referer — the per-port `ssh -L` copy remains the escape hatch.
6. Multi-host UI (post-Phase 6): whether one CLI process can serve several host connections from a single origin (path-per-host routing, e.g. `/h/<host>/…`) instead of one origin per SSH launch. The CLI-serves-UI architecture (§2) leaves this open; one-origin-per-connect is the v1 answer.
