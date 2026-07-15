# Puddle

[![npm](https://img.shields.io/npm/v/@puddle-code/cli?logo=npm)](https://www.npmjs.com/package/@puddle-code/cli)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

Puddle is an open-source, multi-account coding agent orchestrator with first-class SSH support and a lightweight GUI. With a single command,

```bash
puddle connect <user>@<host>
```

Puddle manages parallel agents anywhere you SSH into, insulates agents in dedicated worktrees, and keeps your agents alive across disconnects and restarts.

## Quick start

**On your local machine where you will be using the GUI, run:**

```sh
npm install -g @puddle-code/cli
```

**To launch agents on a remote host:**

```sh
puddle connect <user>@<host>
```

This connects Puddle to the remote host over SSH, bootstrapping the Puddle daemon on first contact and enabling you to begin development.

Puddle works using your system `ssh`, so `~/.ssh/config`, agents, and jump hosts apply.

**For development on your own machine:**

```sh
puddle start
```

This installs the Puddle daemon under `~/.puddle` and serves the GUI at `http://localhost:7433`.

Note that Ctrl-C closes the GUI only, while agent sessions keep running.

**Daemon-only installs:**

Daemon-only installs (no CLI) use the `install.sh` attached to each release — see the Releases page of this repository:

```sh
curl -fsSL https://github.com/PerceptronV/puddle-code/releases/latest/download/install.sh | sh
```

**Host requirements**: Linux (glibc — Ubuntu 22.04+, Debian 12+, RHEL 9+; Alpine is not supported) or macOS, with `git` and `curl`, plus whichever agent CLIs you want on `PATH`. The client side works from any OS with a browser and `ssh` (Windows works, with repeated auth prompts unless you use a key).

## How it works

- **The Puddle daemon works anywhere you can SSH into.** It is installed on your host during every fresh connect, relaying information across SSH to your local GUI. The daemon is the parent of every agent process, keeping sessions running when your laptop sleeps, the window closes, or the SSH connection drops. Puddle also maintains a stateful memory of your conversations to survive machine reboots.
- **Puddle orchestrates parallel isolated agents** each working in a unique git worktree and branch. You can choose the branch and worktree during session creation.
- **Puddle's lightweight GUI** allows you to track agent progress, session usage, and active worktrees.
- **Puddle's philosophy is that any good developer must stay grounded in their code.** Puddle natively integrates live terminals, file editing in Monaco, git commit grahps, diff views, and opens worktrees in your favourite IDE.
- **Multiple profiles and accounts** enable several collaborators to collaborate on a shared remote host. Puddle manages multiple accounts per agent type and profile, symlinking conversation histories so you can run from multiple Claude Code accounts at once and move your conversations between each.

```
 client machine                          host machine (local or remote)
┌──────────────────────────────┐        ┌───────────────────────────────────┐
│ browser ── localhost:7433    │        │  puddled  (systemd user service)  │
│               │              │ local: │   ├─ REST + WS API                │
│  puddle CLI ◄─┘              │ direct │   ├─ PTY manager                  │
│   ├─ static web UI assets    │───────►│   ├─ git worktree manager         │
│   └─ /api + /ws proxy        │ remote:│   ├─ per-agent adapters           │
└──────────────────────────────┘ ssh -L │   └─ SQLite + append-only logs    │
                                        └───────────────────────────────────┘
```

The CLI serves the UI at a stable local origin and reverse-proxies the API to the daemon, directly in local mode, through the tunnel in SSH mode. The daemon is headless and host-agnostic on `127.0.0.1:7434`. UI updates ship with the CLI (`npm update -g @puddle-code/cli` refreshes the cockpit for every host); the daemon only has to update when the versioned protocol breaks, and the CLI does that automatically. A mandatory bearer token plus Host/Origin validation guard the localhost API against malicious web pages.

Everything lives under `~/.puddle` on the host, installed without sudo. Uninstalling is stopping the service and deleting that directory.

## Development & teardown

**One daemon, many clients.** There is a single local daemon per machine, living under `~/.puddle` and run by one supervised service (launchd's `dev.puddle.puddled` on macOS, systemd's `puddled` on Linux). The global `puddle` and a repo-run `node packages/cli/dist/index.js` are **both just clients** that talk to — and, when needed, install — that same daemon. They never run side by side, and there is no separate "dev daemon" alongside a "production daemon".

**Dev build vs. production.** `npm i -g @puddle-code/cli` is the production path — its `puddle` fetches and upgrades the daemon from this repo's GitHub Releases. To exercise uncommitted changes, build and run from the repo:

```sh
pnpm build && pnpm build:tarball
node packages/cli/dist/index.js start --tarball dist-release/puddled-v*.tar.gz --foreground
```

`--tarball` sets the install _source_ only, and is consulted **only when the CLI actually installs the daemon** — when none is running, the daemon is stopped, or a protocol-major upgrade fires. If a compatible daemon (same protocol major) is already up, `start` just serves the cockpit against it and **the tarball is ignored** (even a newer app version — nothing compares app versions). So to load a fresh dev build over a running daemon you must **stop it first** (see _Kill_ below), then re-run `start --tarball …`. `--foreground` keeps the cockpit attached (`connect <user>@<host> --tarball …` is the remote form). Both clients share one `~/.puddle` daemon and cockpit registry, so `puddle list` / `puddle kill` see either — don't point both at the same host at once. (Never launch the daemon from inside a coding-agent shell: it inherits the agent's env and breaks conversation resume — use a plain terminal.)

**Kill.** `puddle kill --all` (or Ctrl-C in a `--foreground` run) stops the local cockpit UI only; the daemon and its agent sessions keep running. The daemon is auto-restarting (launchd `KeepAlive`, systemd `Restart=always`), so a plain `kill <pid>` bounces straight back — stop it through its supervisor:

```sh
launchctl bootout gui/$(id -u)/dev.puddle.puddled   # macOS (launchd)
systemctl --user disable --now puddled              # Linux (systemd user unit)
kill "$(cat ~/.puddle/puddled.pid)"                 # nohup fallback (no supervisor)
```

**Restore the production daemon.** When you're done testing, put the release build back over your dev one: stop the daemon (above), clear the installed binaries with `rm -rf ~/.puddle/bin` (your `~/.puddle` state — profiles, sessions, worktrees — is untouched), then run the production `puddle start`, which refetches the daemon from GitHub Releases. (Clearing `bin` is what forces the refetch: the installer skips a version whose files are already present, so a dev build sharing the release's version number would otherwise stay put.)

**Uninstall.** Removing the CLI alone leaves the daemon installed and running — a full teardown stops the daemon, then removes its state, its service file, and the production CLI:

> ⚠️ `~/.puddle` **is** your local state — the SQLite database with every profile, account, and session (plus conversation history), the daemon's worktree tracking, and the auth token. Deleting it is irreversible and wipes all of it. Uninstall only when you mean to start clean.

```sh
rm -rf ~/.puddle
rm ~/Library/LaunchAgents/dev.puddle.puddled.plist                            # macOS
rm ~/.config/systemd/user/puddled.service && systemctl --user daemon-reload   # Linux
npm uninstall -g @puddle-code/cli
```

## Licence

Puddle is licensed under the [MIT License](LICENSE). Copyright (c) 2026 Yiding Song.
