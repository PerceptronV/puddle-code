# Windows frontend with WSL2 hosts

Status: draft, 2026-11-06. This is a proposed implementation plan, not a claim
that a Windows desktop release, WSL connection mode or the commands below exist.
The source baseline is `2435b16f`. No Windows or WSL acceptance has been run for
this draft. Existing host/runtime ownership rules in [SPEC](../../SPEC.md) apply.

## Outcome and scope

Ship a native Windows Puddle desktop app that runs the existing frontend and
connects to a Linux host inside WSL2 or an existing Linux/macOS host over SSH.
The daemon, independent runtimes, agents, git worktrees and native conversation
stores stay on that host. The Windows app does not emulate Linux services or run
agent PTYs itself.

Proposed first supported configuration: Windows 11 x64, an explicitly selected
WSL2 Ubuntu LTS distribution, a non-root Linux user and a working systemd user
manager. Establish exact tested Windows/WSL/distribution versions in phase 0;
do not infer support solely from a version number. Windows arm64 follows the
same design but needs its own installer, host-architecture discovery and real
acceptance before being advertised. WSL1 and native Windows daemon/runtime
hosting are outside this roadmap.

The Windows app should open a normal Puddle window, offer a WSL distribution or
SSH host, and use the same workspace UI. Agent configuration and authentication
belong to the chosen Linux user. A Windows installation of an agent is not an
agent installation inside WSL.

This remains consistent with SPEC's native-Windows-host non-goal. It is a client
port and a new host transport, with a smaller scope than porting process
supervision, terminal execution and update recovery to Windows.

## Proposed architecture

```text
Windows user session
  Puddle.exe: windows, host picker, prompts, notifications and app updates
    @puddle-code/cli/lib: frontend server, authority, host connection and proxy
      WSL transport: wsl.exe -> exact distribution + Linux user
        Linux host: puddled -> independent puddler owners -> agents and shells
      SSH transport: existing SSH connection -> Linux/macOS host
```

Keep the Electron renderer on the existing Windows loopback frontend origin.
Reuse its invitation exchange, browser credentials, REST/WS proxy and reconnect
behavior. Keep WSL invocation, host discovery, bootstrap, data forwarding and
maintenance under `packages/cli/src/lib/`; both CLI and desktop consume them.
The desktop package owns Windows integration and presentation only.

Use the existing Linux host/runtime archives selected by the architecture
observed **inside the chosen distribution**. Do not derive that architecture
from the Windows app's `process.arch`. No new public daemon protocol is assumed:
review [PROTOCOL.md](../../packages/shared/PROTOCOL.md) if implementation requires
new schemas or messages. Any private bridge protocol still needs explicit
versioning, bounds and compatibility handling.

## Changes required

### 1. Explicit host targets and discovery

Introduce one validated host-target type for local, SSH and WSL connections.
A WSL target records the distribution registration identity and resolved Linux
user identity; the display name is presentation. Investigate a supported stable
registration identifier in phase 0. A distribution name alone must not silently
reconnect to an unregistered/recreated distribution. Also verify host authority
on connection; neither the registration identifier nor a cached label is proof.

Replace assumptions that every target string other than `local` is SSH in the
desktop picker, recent hosts, reopen state, host identity cache and CLI dispatch.
Preserve existing local/SSH records through a deliberate migration. On Windows,
"This computer" opens WSL selection; it must not call `startLocal()` against
Windows. Changing the default WSL distribution or Linux user must not retarget
an already saved connection. Forgetting a target removes client preferences,
not the distribution or its data.

Proposed CLI entry: `puddle launch --wsl <distribution>`, with an optional explicit
Linux user. Use the same selector for logs, install, updates and removal; avoid
encoding WSL targets as SSH hostnames. The final spelling is a CLI design choice,
but it must be unambiguous and preserved through refresh/reopen.

Discover installed distributions without starting every one. Account for WSL
command output encoding, localization, spaces and non-ASCII names. Probe the
selected distribution for WSL2, Linux identity, architecture, home, required host
tools and live user-service-manager availability. WSL installation, distribution
creation and enabling systemd remain explicit setup actions with restart guidance,
not side effects of listing hosts. Microsoft documents distribution selection and
listing in [WSL commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands).

### 2. WSL transport and private authority

Extend `transport/transport.ts` and `transport/open.ts` with an actual WSL
transport. Never label it `local`: existing local branches read Windows files
and connect to Windows IPC when the required state is inside Linux. Audit
`auth/control-channel.ts`, `auth/readiness.ts`, bootstrap, component management
and every transport-kind branch before enabling it.

Run trusted Linux commands through `wsl.exe --distribution ... --user ... --exec`
using argument arrays and a deliberate Linux working directory. Resolve the
system WSL executable rather than trusting a project-local executable. Keep
Windows command-line quoting separate from Linux shell quoting; never build a
PowerShell/cmd command from a distribution name or filename. The existing
transport's trusted `sh -c` command contract may be retained inside Linux.

Implement execution, bounded output capture, file reads, streamed file delivery,
cancellation and a binary-safe `openChannel`. Reuse the staged host-control
helper to connect to the selected Linux user's private control socket. Its
stdout carries protocol data only; stderr is bounded diagnostics. Do not scrape
credentials from logs, expose host-control endpoints over HTTP, or bypass the
existing participating authority and lease lifecycle.

Keep Windows client state and Linux host state separate. A Windows `PUDDLE_HOME`
must not become a Linux path by inheritance. Scope any host-home override
explicitly and include it in target isolation. Do not copy Windows provider
credentials, agent-orchestration variables or arbitrary `WSLENV` mappings into
the host. Validate Linux tool resolution so Windows PATH entries do not silently
select Windows agent executables. Reuse normal shell-environment capture inside
Linux instead of maintaining a second agent configuration system.

For local host archives, stream to private Linux staging and verify checksums
there. Fix bootstrap's POSIX-only basename assumptions for Windows source paths;
do not expose Windows paths as host paths or rely on a fixed `/mnt/c` mapping.

### 3. Frontend traffic, ports and authentication callbacks

Add WSL connection composition beside `connection/start.ts` and `connect.ts`.
Share existing frontend setup where responsibilities match; do not duplicate
bootstrap, lease recovery or host-update logic in an Electron-only WSL path.

Windows-to-WSL networking is an explicit phase-0 decision. NAT and mirrored
networking differ, and localhost alone is not distribution identity. Two hosts
may use the same daemon or development-server port. A successful TCP probe or
`/api/version` response must not choose the host. Microsoft describes the modes
in [WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking).

Preferred baseline to prototype: a distribution-scoped data bridge reached
through `wsl.exe`, forwarding only to the selected host's approved loopback
endpoints. Keep the private authority channel separate. Reuse existing stream
primitives where appropriate; specify connection/frame/byte limits, backpressure,
half-close, cancellation and bounded diagnostics before adopting a multiplexed
bridge. Avoid one new WSL process for each HTTP request or terminal packet.
No SSH server, LAN listener or Windows firewall rule should be required for WSL.

A direct loopback fast path is optional only after exact authority verification
and multi-distribution testing. Do not fall back to a guessed WSL IP, another
distribution or another host after an authentication failure. Resolve the bridge
choice with measurements before committing to a new transport protocol.

Carry REST, WebSocket upgrades, terminal replay, file transfer and existing
development-port proxies through the selected connection. Preserve routing and
Origin checks; the renderer cannot submit arbitrary bridge destinations. Handle
Windows browser OAuth callbacks explicitly, especially Codex's fixed callback
port. A port already owned by another target must produce an actionable conflict,
not deliver credentials to the wrong distribution. Reconnect restores transport
and fresh authority; it never replays uncertain prompts or mutations.

### 4. Runtime lifetime, shutdown and host maintenance

Keep the current Linux installers, independent runtime owners, controller
claims, pinned releases, placement reconciliation and update coordinator.
Require demonstrated systemd **user** supervision for the initial WSL support
claim. Merely finding PID 1 named systemd is insufficient. Do not silently enable
lingering, change system configuration or weaken runtime admission when a user
manager is unavailable.

WSL shutdown, distribution termination, Windows reboot and some session-lifetime
transitions end Linux processes. Systemd support does not itself guarantee that
WSL stays alive; Microsoft explicitly notes this in its
[systemd announcement](https://devblogs.microsoft.com/commandline/systemd-support-is-now-available-in-wsl/).
Closing a Puddle window must not issue `wsl --terminate` or `wsl --shutdown`.
It releases viewers and connection resources, leaving host processes to their
existing ownership and WSL lifetime. Do not promise agents survive app closure
until real acceptance establishes the supported behavior.

Phase 0 must decide whether the supported experience needs a separate, visible
keep-running policy to maintain WSL activity after all frontend windows close.
Do not disguise a hidden keepalive process as durable OS supervision. Until
resolved, describe process survival as bounded by WSL lifetime and distinguish
retained conversations from live shell/process state.

On reconnect, use authenticated owner adoption and normal interrupted-session
recovery. A failed Windows bridge or HTTP probe cannot prove a Linux owner died.
Detect changed boots through existing host evidence. Respect host auto-resume;
never replay a pending automated turn or claim a lost shell variable survived.

Frontend host updates must retain exact review/approval, selected-release checks,
participating authority, cancellation and observation-only handling after lost
dispatch replies. Include read-only offline status and explicit continuation
through the WSL host helper, without treating a failed live mutation as permission
to retry offline. Updating/uninstalling the Windows app affects the client only;
it must not stop owners, remove Linux data or unregister a distribution.

### 5. Files, agent login and Windows integration

Projects, worktrees, SQLite and native transcripts belong in the Linux filesystem.
Prefer repositories under the selected Linux user's home. Existing editor/search/
git operations stay daemon-side; do not add a second filesystem implementation
that reads Linux projects through Windows UNC paths. Microsoft's
[filesystem guidance](https://learn.microsoft.com/en-us/windows/wsl/filesystems)
also recommends keeping Linux workloads on the Linux filesystem for performance.

Path conversion belongs at explicit boundaries: import a Windows-selected file,
download a host file, reveal a folder in Explorer or open an external editor.
Use selected-distribution-aware conversion and separate Windows/POSIX path
utilities. Test spaces, Unicode, case differences, symlinks and mounted drives.
UNC reveal must retain the exact distribution identity and never become an
alternate trusted data/control path. Mounted Windows repositories require a
separate acceptance decision for Git permissions, watching and file semantics.

Reuse the Windows clipboard, notifications and external browser through Electron.
Add the installer/application identity required by Windows notifications and
verify notification clicks return to the exact host/project/session. Audit native
shell helpers, command-key handling, Windows console flashes and editor links.

Agents are installed and logged in inside WSL through the normal account flow.
Verify authentication URLs open in the Windows browser and callback traffic
returns to the correct Linux account. Test Codex, Claude, Gemini and OpenCode
native creation, switching, fork/clear, resume and hook/plugin routing; Linux
execution reuse is not a substitute for cross-boundary acceptance.

For Windows-to-SSH connections, preserve existing no-ControlMaster handling and
replace the POSIX askpass launcher in `desktop/src/ssh-askpass.ts` with a Windows
executable helper. Verify passwords, host-key confirmation, passphrases, agent
keys, cancellation and reconnect without logging secrets. WSL connections do
not need SSH authentication.

### 6. Windows installation, security and updates

Proposed distribution: per-user Windows x64 NSIS installer, with a stable app
identity, shortcuts, uninstall entry and Authenticode signing. Add native Windows
packaging to the release workflow, a Windows icon and checksums. Reuse the existing
release source and component manifest. Do not require system Node/npm or an
elevated desktop process. See the pinned-major
[electron-builder NSIS documentation](https://www.electron.build/v26/docs/nsis/)
and [Electron signing guidance](https://www.electronjs.org/docs/latest/tutorial/code-signing).

`installation/desktop-update.ts` currently selects macOS ZIP/Linux AppImage assets
and applies updates with `/bin/sh`. Add explicit Windows asset/staging/apply
handling and installation inventory. Prefer letting the verified NSIS installer
perform Windows file replacement rather than extending the POSIX rename script.
Keep current release discovery/checksum verification; verify publisher identity
as part of the signed Windows release path. Specify installer arguments, process
exit/locking, cancellation, failure recovery and relaunch before enabling the
update offer. Do not silently switch the other platforms to electron-updater.

Audit client state security before storing Windows authority. Existing code has
named-pipe support and a launcher secret, but skips POSIX mode checks on Windows.
Provide/test current-user ACLs for authority files and pipe access, reparse-point
handling and atomic replacement behavior. A working named pipe or `chmod(0600)`
call alone does not establish equivalent Windows protection. Separate authority
from cosmetic recent-host/window preferences.

Split CI builds at the existing package boundary so a Windows client build does
not need to compile or execute Linux-only daemon dependencies. Preserve the
embedded host installers/helper assets. Any Windows standalone CLI distribution
needs a native launcher/install path; it cannot reuse the shell-only standalone
installer unchanged. The Linux CLI inside WSL continues to use Linux releases.

## Implementation seams

Paths below are existing responsibilities, not instructions to centralize all
Windows logic in one module. Keep new WSL helpers together beside transport and
connection code; keep `lib/index.ts` as the deliberate embedder API.

| Area | Existing code to extend or audit |
| --- | --- |
| Target selection and persistence | `cli/src/cli/args.ts`, `cli/src/lib/transport/open.ts`, `desktop/src/main.ts`, `recent-hosts.ts`, `reopen.ts` |
| WSL execution and data bridge | `cli/src/lib/transport/`, `connection/start.ts`, `connection/connect.ts`, `connection/frontend.ts` |
| Host authority and maintenance | `cli/src/lib/auth/control-channel.ts`, `connection-authority.ts`, `host/updates/`, `installation/host/` |
| Bootstrap and path delivery | `cli/src/lib/installation/bootstrap.ts`, `paths.ts`, `transport/transport.ts`, `host/file-manager.ts` |
| Windows shell integration | `desktop/src/ssh-askpass.ts`, `main.ts`, notification and preload modules |
| Client storage security | `shared/src/node/security.ts`, `cli/src/lib/auth/launcher.ts` |
| Packaging and client updates | `desktop/electron-builder.yml`, desktop/CLI build scripts, `cli/src/lib/installation/desktop-update.ts`, `component-versions.ts`, `.github/workflows/release.yml` |

All paths in this table are relative to `packages/`, except `.github/`.

## Delivery phases and acceptance

All phases are unimplemented. Complete each phase's exit criteria before claiming
its behavior; fixture-only checks cannot close native Windows/WSL acceptance.

| Phase | Work | Exit criteria |
| --- | --- | --- |
| 0. Native feasibility | Select test versions; prove exact distribution/user identity, user supervision, stdio behavior, network routing and WSL lifetime; benchmark bridge alternatives | Two distributions with overlapping ports cannot cross-route; document measured lifecycle and choose the bridge/keep-running policy |
| 1. Shared connection | Add typed targets, WSL transport, private authority and frontend composition; implement path-safe bootstrap and cancellation | CLI/library can launch/connect to an isolated WSL host, stream terminals/files and reconnect without a duplicate owner or Windows-side host state |
| 2. Desktop experience | WSL picker, reopen migration, setup errors, authentication/browser callbacks, Explorer/editor boundaries and Windows SSH helper | Packaged Windows frontend supports fresh account login, independent tabs, native session commands and exact host restoration |
| 3. Ownership and maintenance | Exercise WSL shutdown/reboot, daemon/runtime upgrades, disconnected status, explicit recovery and client update teardown | Existing owner, approval and uncertain-dispatch guarantees hold across Windows/WSL failure boundaries |
| 4. Distribution | Windows installer/signing/update/uninstall, current-user storage protections, native CI and support documentation | Fresh Windows machine works without Node/npm; installer/update recovery and native acceptance pass before stable release |

The acceptance matrix must include:

- WSL absent, WSL1, no distro, uninitialized distro, missing user manager, missing
  tools and unsupported architecture; no silent installation or fallback.
- Two distributions and two users, default changes, renamed/recreated targets,
  stale saved identities, locale/Unicode names and Windows paths with spaces.
- NAT and mirrored networking, VPN/firewall constraints, port collisions, a wrong
  local listener, OAuth callback conflicts, large transfers and slow consumers.
- Closing one/all windows, quitting/updating the app, Windows sleep/resume, loss
  of the bridge, Linux daemon replacement, `wsl --terminate`, WSL shutdown and
  Windows reboot. Distinguish preserved processes from resumed conversations.
- All supported agents: create, input, cancel, `/new`, `/clear`, `/fork`, native
  selection, account isolation, hooks, original/copy independent input and resume.
- Fresh/dirty repositories, editor save, watching, Git operations, drag/drop and
  transfer cancellation; explicit tests for mounted Windows repositories if offered.
- Exact host-update approval and cancellation, lost replies before/after dispatch,
  authority revocation, offline observation and recovery without a second mutation.
- Windows user isolation, pipe pre-creation/replacement, inherited ACLs, malicious
  reparse points, installer failure, locked app files and uninstall preserving WSL.

Run portable unit/contract tests in ordinary CI. Use a Windows host with actual
WSL2/nested-virtualization capability for native tests; a standard Windows build
runner or mocked `wsl.exe` is not evidence of that capability. Use disposable
distributions, synthetic transcripts and loopback model fixtures for deterministic
agent tests. Retain explicit manual acceptance for real provider login and Windows
desktop interaction. Publish no user profiles, credentials or local reports.

Measure desktop launch, stopped-distribution startup, warm connection, authority
acquisition, daemon readiness, agent creation, first replay and first usable
input separately. Compare with the same Linux agent/configuration running directly
inside WSL. Record medians and tail latency plus idle process/CPU cost; do not
promise the existing isolated macOS startup figures apply to Windows.

## Decisions to close before implementation expands

1. Confirm the first native test host and supported Windows/WSL/Ubuntu versions.
2. Resolve exact registration identity and stale-target migration without relying
   on undocumented registry mutations.
3. Select the measured bridge design and define its limits, cancellation and
   compatibility contract; include OAuth and development-port routing.
4. Decide and test the user-visible WSL lifetime/keep-running promise.
5. Establish signing credentials and Windows installer/update recovery behavior.
6. Decide whether Windows arm64 and mounted Windows repositories join the initial
   supported matrix or follow after x64/Linux-filesystem acceptance.

There is no calendar estimate yet: phase 0 bounds the transport and lifetime
risks. The UI largely carries over, but a usable Windows client includes these
connection, identity, installation and recovery requirements. Native Windows
daemon/runtime support remains a separate future project.
