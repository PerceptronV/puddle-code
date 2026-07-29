# Report: file-explorer render loop pinned a core per workspace window

**Date:** 2026-07-28 · **Affected:** every release up to and including v0.0.13
(since the explorer landed in `ca2e25f`) · **Fixed in:** the commit carrying
this report

## Symptom

macOS listed Puddle under "Using Significant Energy" — ahead of every other
app — even with the v0.0.12 battery fixes (terminal detach, paused polls,
stat-guarded title refresh) in place. Inspection showed each open workspace
window's renderer process pinned at ~100% CPU from the moment it opened, for
its entire lifetime. Two windows meant two performance cores burning
continuously (very roughly 5–10 W on Apple silicon).

## Root cause

`ExplorerProvider` (`packages/web/src/features/explorer/explorer-context.tsx`)
keeps a `rowsVersion` counter so the flat visible-row list recomputes when a
directory's tree query lands. It bumped that counter from a
`queryClient.getQueryCache().subscribe(...)` callback on **any** cache event
for a `wt-tree` query.

TanStack Query's cache also emits **observer** events, and those fire during
React renders themselves: every render of `useWorktreeTree` rebuilds its
inline `queryFn`, so the observer's shallow options comparison fails and
`setOptions` emits `observerOptionsUpdated`. That closed a loop:

```
cache event → setRowsVersion → provider re-renders → every DirEntries
re-renders → each useQuery re-runs setOptions → observerOptionsUpdated → …
```

The loop runs at React-scheduler speed with no timers and no network, so it
was invisible to everything except a CPU profile: `ps` showed a lifetime
average of ~102% CPU per renderer, and a CDP `Profiler` capture showed 0%
idle — one uninterrupted render storm across the workspace tree, context
menus, and dialogs. It ran whenever the Files view was mounted.

## Fix

The subscription now ignores observer events and reacts only to query-state
events — `added`, `removed`, `updated` — which are the only events that can
change what `getQueryData` returns, and which never fire from a render.

**Lesson for future work:** never call `setState` from a query-cache
subscription without filtering event types. Observer events fire during
renders; reacting to them closes a render loop that production React enters
silently (the "getSnapshot should be cached"-style warnings are dev-only).

## Measurements

Method: the built bundle served over the live daemon (static server proxying
`/api` + `/ws` to `127.0.0.1:7434`), loaded in a headless Chromium driven via
CDP, on a real workspace view — file tree mounted plus an attached session
terminal — left to settle, then sampled with `top -l 5 -s 8` (CPU / POWER /
MEM) over 40 s. "Before" numbers are the shipped v0.0.13 desktop app on the
same machine (Apple silicon, two workspace windows).

### Idle CPU / energy

| Process                        | Before (v0.0.13)   | After (fixed)      |
| ------------------------------ | ------------------ | ------------------ |
| UI renderer, per window        | 83–112% CPU        | 0–1.2% CPU         |
| macOS energy impact (`POWER`)  | 65–112 per window  | ~0–1               |
| App main process               | ~0.2%              | ~0.2%              |
| GPU / network helpers          | ~1% combined       | ~1% combined       |
| Daemon (`puddled`)             | 0.2–0.8%           | 0.2–0.8%           |

Whole app after the fix: **~1–2% of one core, total, at idle** (residual =
terminal cursor blink + daemon heartbeats) — below the threshold macOS uses
for the "Using Significant Energy" list.

### Idle RAM (unchanged by the fix — the bug was CPU, not memory)

| Process                  | Footprint                                      |
| ------------------------ | ---------------------------------------------- |
| Daemon                   | ~63 MB                                         |
| App main process         | ~66 MB (+ ~9 MB network helper)                |
| GPU helper               | ~330 MB (compositor surfaces, two windows)     |
| Renderer, per window     | ~150–300 MB (87 MB headless; Monaco/xterm and scrollback add the rest) |

Total ≈ 500 MB with one window, ~800 MB–1 GB with two — normal Electron-class
footprint.

## Reproducing the measurement

1. `pnpm build`, then serve `packages/cli/dist/public` with `/api` + `/ws`
   (WebSocket upgrade included) proxied to the daemon.
2. Launch a Chromium with `--headless=new --remote-debugging-port=<p>`, open
   `/#token=<daemon token>`, set `localStorage['puddle.profile-id']`, navigate
   to a `/project/<id>` route.
3. Attach to the page's `webSocketDebuggerUrl` and use `Profiler.start` /
   `Profiler.stop` for JS profiles; `top -pid <renderer>` for CPU/energy/RSS.
