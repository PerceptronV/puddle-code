# Codex selections copied only to the daemon host

Codex 0.157.1 could report **Copied … chars to host clipboard** without sending
any selected text to the viewing browser. The browser's existing OSC 52 bridge
could therefore wait for a reply which never arrived. This reproduces even when
normal mouse dragging and the forwarded copy key both reach Codex correctly.

## Finding

Codex first attempts a native clipboard write. When it detects an SSH session
through the presence of `SSH_TTY` or `SSH_CONNECTION`, it also emits OSC 52.
Outside tmux, without that detection a successful native write ends the operation;
terminal copy is only a fallback after native failure. A supervised daemon need not
inherit either SSH variable, even when a viewer connects through an SSH tunnel.

The adapter now supplies `SSH_TTY=''` when no real value exists. Codex checks
presence, so no invented tty path or SSH endpoint is needed. This applies to
launches and resumes through the existing adapter environment. The daemon's
environment is unchanged; its separately spawned lifecycle app-server does not
receive the synthetic marker. Direct fallback launches inherit the marker in
their embedded backend as well as the TUI. `CODEX_HOME` still controls account
isolation. No API or protocol change is required.

## Live verification

Tested the installed Codex 0.157.1 binary on macOS with an isolated temporary
home and account, a trusted empty workspace, update checks disabled, and an
unauthenticated provider pointing at an unused loopback port. Launched Codex
with `--no-daemon`; no prompt was submitted and no Puddle daemon was launched.
The initial environment had neither SSH marker. Typed `puddle clipboard probe`
into the composer, selected it with ordinary mouse dragging, and copied once.

A Chromium xterm viewer received the real PTY output and used Puddle's production
`terminalClipboard` and `writeTerminalClipboard` functions. Its Clipboard API
was replaced with an isolated sink that resolved the production `ClipboardItem`
data. This separation is essential: reading the OS clipboard on the same machine
would falsely pass when Codex wrote to the host directly. The fixed runs used
the built adapter's actual `env` result.

| Environment | Copy key | OSC 52 replies | Isolated browser clipboard |
| --- | --- | --- | --- |
| No SSH marker | Ctrl+C | 0 | Unchanged |
| Adapter environment | Ctrl+C | 1 | `puddle clipboard probe` |
| Adapter environment | Command+C | 1 | `puddle clipboard probe` |

All three runs reported **Copied 22 chars to host clipboard**. With the marker,
native success still determines that notice even though terminal delivery also
succeeds. Selecting alone left the browser sink unchanged, the fixed copies
each made exactly one browser write, and no clipboard errors were reported.

Adapter regression tests cover marker presence without inherited SSH state,
preserving a real tty, and keeping the separate app-server environment clean.
The terminal unit and browser suites separately cover real Clipboard API writes
from delayed OSC replies, cancellation, replay and local selection. The live experiment
verifies Codex's emission and browser consumption; it does not exercise an
actual SSH tunnel or Safari's clipboard permissions. Those remain in
`docs/acceptance/phase-4.md`.

## Applying the fix

Update the daemon on the host and start or resume the affected Codex process.
Refreshing the UI alone cannot change an existing process's environment. The
browser must also include the OSC 52 copy bridge shipped in v0.2.12. No daemon
upgrade or running user-session restart was performed during this investigation.
