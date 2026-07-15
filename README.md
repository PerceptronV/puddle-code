# puddle

A self-hosted orchestrator for CLI coding agents — Claude Code, Codex, OpenCode, and friends. Run many agents in parallel, each isolated in its own git worktree, managed from one browser cockpit. First-class SSH support: the same one command that starts puddle on your laptop bootstraps it on a remote box and reaches it through a single tunnel.

Because a persistent daemon — not a login shell or a browser tab — is the parent of every agent process, **sessions keep running when your laptop sleeps, the window closes, or the SSH connection drops**, and they survive machine reboots by resuming from each agent's on-disk conversation state.

## What you get

- **Parallel agents, isolated by default** — every session gets its own git worktree and branch (opt-outs for shared branches/directories exist when you want them).
- **A full cockpit in the browser** — live terminals (xterm.js), Monaco file editing, diff review against base, an interactive commit graph, filename+content search, drag-in/drag-out file transfer, and a worktree manager.
- **Remote-first** — `puddle connect user@host` installs the daemon on the host (no Node, npm, or compiler needed there), opens one SSH tunnel, and serves the same cockpit at `http://localhost:7433`. Dev servers your agents start are reachable through a built-in reverse proxy, HMR included.
- **Detached by design** — close everything; agents keep working. Reattach from the browser or a raw terminal (`puddle attach`).
- **Multiple profiles and accounts** — per-collaborator profiles on a shared box, several accounts per agent, and one-click migration of a session to another account when you hit a usage limit.

## Quick start

```sh
npm install -g @puddle-code/cli
```

**On your own machine:**

```sh
puddle start
```

Installs the daemon under `~/.puddle` (versioned, supervised by systemd/launchd), serves the cockpit at `http://localhost:7433`, and opens your browser. Ctrl-C closes the cockpit only — sessions keep running.

**On a remote box:**

```sh
puddle connect user@devbox
```

One SSH authentication at most (keys, passwords, and 2FA all work — puddle drives your system `ssh`, so your `~/.ssh/config`, agents, and jump hosts apply). The daemon is bootstrapped on first contact and upgraded automatically when the protocol requires it.

**Everything else:**

```sh
puddle status  [user@host]             # daemon version + session table
puddle attach  [user@host] <session>   # raw-terminal attach; Ctrl-] detaches
puddle logs    [user@host] [session] -f
puddle upgrade [user@host]
```

Daemon-only installs (no CLI) use the `install.sh` attached to each release — see the Releases page of this repository:

```sh
curl -fsSL https://github.com/<owner>/puddle/releases/latest/download/install.sh | sh
```

**Host requirements**: Linux (glibc — Ubuntu 22.04+, Debian 12+, RHEL 9+; Alpine is not supported) or macOS, with `git` and `curl`, plus whichever agent CLIs you want on `PATH`. The client side works from any OS with a browser and `ssh` (Windows works, with repeated auth prompts unless you use a key).

## How it works

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

The CLI serves the UI at a stable local origin and reverse-proxies the API to the daemon — directly in local mode, through the tunnel in SSH mode. The daemon is headless and host-agnostic on `127.0.0.1:7434`. UI updates ship with the CLI (`npm update -g @puddle-code/cli` refreshes the cockpit for every host); the daemon only has to update when the versioned protocol breaks, and the CLI does that automatically. A mandatory bearer token plus Host/Origin validation guard the localhost API against malicious web pages.

Everything lives under `~/.puddle` on the host, installed without sudo. Uninstalling is stopping the service and deleting that directory.

## Development

pnpm monorepo: `packages/shared` (zod protocol schemas — the single source of truth for every API shape), `packages/daemon`, `packages/web` (React + Tailwind), `packages/cli`.

```sh
pnpm install
pnpm dev            # daemon (watch) + vite dev server
pnpm test           # vitest across all packages
pnpm lint
pnpm build          # web assets land inside the CLI package
pnpm build:tarball  # self-contained daemon tarball for this platform
```

Read `SPEC.md` (the full design), `CLAUDE.md` (contributor/agent conventions — British English, changelog discipline, protocol bump rules), `HUMANS.md` (the UI design brief), and `packages/shared/PROTOCOL.md` before making changes. Manual acceptance scripts live in `docs/acceptance/`.

## Status

Phases 0–6 of the SPEC are implemented: daemon core, cockpit UI, files/diff/history, terminal links, port forwarding with the tier-2 proxy, and the CLI with distribution. Upcoming: more agent adapters with cross-agent hand-off (Phase 7), and the prompt bank, notifications, and polish (Phase 8).

## Licence

[MIT](LICENSE)
