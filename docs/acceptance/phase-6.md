# Phase 6 acceptance — the puddle CLI: serving switch, SSH bootstrap, tunnel (manual)

SPEC §14 Phase 6 acceptance, run by hand: local mode on this machine, SSH
mode against a real host you can ssh into (a spare Linux box or VM is ideal —
the bootstrap installs a systemd user unit there). The proxy/handshake/attach
logic is unit- and integration-tested in CI (including a full `connect` over
a fake ssh shim); everything below exercises real ssh, a real supervisor, and
a real browser.

> **Never launch `puddled` from inside a coding-agent session** (CLAUDE.md):
> a daemon started from an agent terminal inherits `CLAUDECODE`/`CLAUDE_CODE_*`
> and its claude sessions will not resume. Run everything below from a plain
> shell.

Setup — build everything and a tarball for this platform (no GitHub release
needed; `--tarball` is the dev override):

```sh
pnpm build && pnpm build:tarball
alias puddle='node packages/cli/dist/index.js'
```

For the remote host you also need a linux tarball. Either download one from a
real release, or build on the host itself (`pnpm build:tarball` in a checkout
there) and use its path with `--tarball` after copying it back — the flag
takes a CLIENT-side path and delivers it over scp.

1. **Local mode, fresh machine.** With no `~/.puddle` (or `PUDDLE_HOME` set to
   a scratch dir): `puddle launch --tarball dist-release/puddled-v*-<os>-<arch>.tar.gz`.
   Expect: installer output, then `puddle cockpit at http://localhost:7433`,
   the browser opening a working cockpit (no token gate — the `#token=`
   fragment authenticates and is stripped from the address bar). Create a
   project and a session; the agent runs. `~/.puddle/bin/current` points at
   `versions/<v>`; on macOS `launchctl list | grep puddle` shows the agent,
   on Linux `systemctl --user status puddled` is active.
2. **Ctrl-C detaches, not kills.** Ctrl-C the `puddle launch` process — it
   prints that sessions keep running. The daemon still answers (`puddle
   status` — expect the version line and your session). Re-run `puddle launch`:
   the same cockpit returns without reinstalling.
3. **SSH mode, fresh host.** On a box with no puddle installed:
   `puddle launch user@host [--tarball <linux tarball>]`. Expect: one ssh
   auth prompt at most (key or password), installer output, then a cockpit at
   `http://localhost:7433` (or the next free port) whose top bar shows
   `user@host`. The browser URL carried `?host=user@host` (stripped after
   load). Create a session; it runs on the host.
4. **Everything through one tunnel.** In the workspace: terminals stream,
   files open and save, diffs render. Start a dev server in a session
   (`python3 -m http.server 8000`); the ports strip shows 8000 offering
   **Open via proxy** (no localhost link — this window is tunnelled) and the
   proxied tab works. A `http://localhost:8000` URL printed in the terminal
   opens via the proxy too (cmd+click it).
5. **Sessions survive the laptop.** Ctrl-C `puddle launch`, close the
   browser. On the host the agent keeps working (`puddle status user@host`
   from the client, or `systemctl --user status puddled` on the host).
   `puddle launch user@host` again: the cockpit returns, terminals replay.
   This step assumes a working persistent supervisor.
6. **SSH-attached fallback.** Repeat SSH mode against a host with no usable
    systemd/launchd whose login service reaps a detached nohup child. Expect a
    warning that Puddle is keeping the daemon attached to this cockpit, then a
    working UI. Create a session and note a durable file or database-backed
    setting; Ctrl-C the foreground cockpit. Expect a clean interruption
    message, `~/.puddle/puddle.db`, worktrees, logs, and agent configuration to
    remain. Launch again: the daemon starts on entry, the same data appears,
    and interrupted sessions auto-resume when the host setting is enabled.
7. **Attach from a raw terminal.** `puddle attach user@host <session-prefix>`:
   the log tail replays, keystrokes reach the agent, window resize reflows,
   Ctrl-] detaches leaving the session running. `puddle logs user@host
   <session-prefix>` prints the same output; `-f` follows.
8. **Older-major auto-update.** On the host, fake an older protocol:
   `ln -sfn versions/<old> ~/.puddle/bin/current && systemctl --user restart
   puddled` with any earlier-major build (or temporarily edit
   `PROTOCOL_VERSION` and rebuild a tarball). `puddle launch user@host`
   prints the live-session interruption count, reinstalls, restarts, and
   lands in the cockpit; the interrupted sessions show resume buttons and
   resume with history. `--no-upgrade` instead aborts with the count.
9. **Mode switching on one origin.** After the SSH session, run a local
   `puddle launch` on the same machine. The ports strip now offers **Open
   localhost** (the stale `user@host` from step 3 was cleared by the local
   boot); editor deep links open local paths.
10. **install.sh by hand (daemon-only path).** On a scratch host:
   `PUDDLE_REPO=<owner>/<repo> sh scripts/install.sh` (or `--tarball <path>`).
   Expect platform detection, checksum verification, versioned install,
   supervisor start, and a status line. Re-running is a no-op; `--version
   <older>` flips the symlink back (rollback).
11. **Fresh desktop install (macOS).** With Puddle absent from both
    `/Applications` and `~/Applications`, run `puddle upgrade desktop` from a
    released CLI. It downloads and verifies the latest mac zip, then installs
    `/Applications/Puddle.app` when that directory is writable, otherwise
    creates `~/Applications/Puddle.app`. No `.old` bundle is required or left
    behind. Run the command again with the app closed: it reports current (or
    performs the normal replacement if a newer release exists).
12. **Desktop SSH authentication.** In the desktop app, choose File →
    **Connect to SSH Host…** and target a host that requires password plus
    keyboard-interactive/2FA authentication (with no warm ControlMaster).
    Expect a masked SSH Authentication dialogue for each response, then the
    normal cockpit window. Cancel one prompt and confirm the connection fails
    without saving the host as a recent. Repeat with a previously unknown test
    host and confirm its authenticity is presented as explicit Yes/No buttons.

Record any deviations as issues before ticking the phase off.
