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
   a scratch dir): `puddle start --tarball dist-release/puddled-v*-<os>-<arch>.tar.gz`.
   Expect: installer output, then `puddle cockpit at http://localhost:7433`,
   the browser opening a working cockpit (no token gate — the `#token=`
   fragment authenticates and is stripped from the address bar). Create a
   project and a session; the agent runs. `~/.puddle/bin/current` points at
   `versions/<v>`; on macOS `launchctl list | grep puddle` shows the agent,
   on Linux `systemctl --user status puddled` is active.
2. **Ctrl-C detaches, not kills.** Ctrl-C the `puddle start` process — it
   prints that sessions keep running. The daemon still answers (`puddle
   status` — expect the version line and your session). Re-run `puddle start`:
   the same cockpit returns without reinstalling.
3. **SSH mode, fresh host.** On a box with no puddle installed:
   `puddle connect user@host [--tarball <linux tarball>]`. Expect: one ssh
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
5. **Sessions survive the laptop.** Ctrl-C `puddle connect`, close the
   browser. On the host the agent keeps working (`puddle status user@host`
   from the client, or `systemctl --user status puddled` on the host).
   `puddle connect user@host` again: the cockpit returns, terminals replay.
6. **Attach from a raw terminal.** `puddle attach user@host <session-prefix>`:
   the log tail replays, keystrokes reach the agent, window resize reflows,
   Ctrl-] detaches leaving the session running. `puddle logs user@host
   <session-prefix>` prints the same output; `-f` follows.
7. **Older-major auto-update.** On the host, fake an older protocol:
   `ln -sfn versions/<old> ~/.puddle/bin/current && systemctl --user restart
   puddled` with any earlier-major build (or temporarily edit
   `PROTOCOL_VERSION` and rebuild a tarball). `puddle connect user@host`
   prints the live-session interruption count, reinstalls, restarts, and
   lands in the cockpit; the interrupted sessions show resume buttons and
   resume with history. `--no-upgrade` instead aborts with the count.
8. **Mode switching on one origin.** After the SSH session, run a local
   `puddle start` on the same machine. The ports strip now offers **Open
   localhost** (the stale `user@host` from step 3 was cleared by the local
   boot); editor deep links open local paths.
9. **install.sh by hand (daemon-only path).** On a scratch host:
   `PUDDLE_REPO=<owner>/<repo> sh scripts/install.sh` (or `--tarball <path>`).
   Expect platform detection, checksum verification, versioned install,
   supervisor start, and a status line. Re-running is a no-op; `--version
   <older>` flips the symlink back (rollback).

Record any deviations as issues before ticking the phase off.
