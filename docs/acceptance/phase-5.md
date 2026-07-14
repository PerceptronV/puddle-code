# Phase 5 acceptance — ports detection, tier-2 proxy, ports strip (manual, real browser)

SPEC §14 Phase 5 acceptance, run by hand against the built daemon with a real
git repo and a real logged-in claude-code account, over an actual `ssh -L`
tunnel so the "SSH mode" paths (§9) are exercised for real rather than
assumed from local mode. The pure logic (the `ssh -L` string builder, the
`puddle_token` query-param stripper, cookie construction, hop-by-hop header
handling) is unit-tested in CI; everything below needs a live process tree,
a live TCP listener, or an actual browser tab and cannot run under vitest.

Setup (reuse Phase 4's daemon-boot block, plus a second terminal for curl):

```sh
pnpm build
export PUDDLE_HOME=$(mktemp -d)
node packages/daemon/dist/index.js &
until [ -f "$PUDDLE_HOME/token" ]; do sleep 0.2; done   # the daemon writes it on boot
open "http://127.0.0.1:7433/#token=$(cat $PUDDLE_HOME/token)"
```

**Start the daemon from a plain shell, not from inside this (or any) coding-agent
session** — see CLAUDE.md / phase-4.md's identical warning; `puddled` inherits
`CLAUDECODE`/`CLAUDE_CODE_*` and breaks `--resume` for any agent it spawns.

Create a profile, a project against a real git repo, and add + log in a real
claude-code account. For the tunnel-dependent steps, run the daemon on a
second machine (or a second user namespace) and reach it via
`ssh -L 7433:127.0.0.1:7433 user@host` so the browser genuinely can't tell
local from tunnelled — the whole point of §9's "always show all three
options" decision.

1. **Detection.** Start a session. Ask the agent to scaffold a Vite app
   (`npm create vite@latest . -- --template vanilla`) and run `pnpm dev`
   (or `npm run dev`). Within 5s the ports strip appears under the terminal
   with one chip (the Vite port, usually `5173`); hovering it shows a
   tooltip `node · pid <pid>`. Ask the agent to stop the server — the chip
   disappears within one poll (≤5s).
2. **Open localhost.** Restart the dev server. Click the port chip → **Open
   localhost**: a new tab opens `http://localhost:<port>` and the app
   renders directly (only meaningful in local mode — over the tunnel this
   tab will fail to connect, which is expected and is why tier 2 and tier 1
   exist).
3. **Open via proxy — base path.** Ask the agent to configure Vite's `base`
   so assets resolve under the proxy prefix, e.g. add
   `base: '/proxy/<sid>/<port>/'` to `vite.config.js` (substitute the real
   session id and port) and restart `pnpm dev`. Click **Open via proxy**: the
   app renders **through** `/proxy/<sid>/<port>/`, not directly — confirm via
   devtools Network that document/asset requests hit the proxied path. Note
   for the record: this manual `base` edit is the documented §15.5
   limitation (puddle does not rewrite HTML/asset URLs) — apps that assume
   they are served from `/` need this one-line config change, or fall back
   to **Copy ssh -L** and a manually-forwarded tab instead.
4. **Token hygiene — address bar and cookie.** After step 3's redirect
   settles, confirm the address bar shows no `puddle_token` (it was in the
   first-hit URL only). Open devtools → Application → Cookies: a
   `puddle_proxy` cookie is present with `Path=/proxy` and `HttpOnly` set.
5. **HMR through the proxy (SPEC §14 Phase 5 AT).** With the proxied tab
   still open, ask the agent to edit a source file the running app renders
   (e.g. change some visible text). The browser updates via HMR without a
   full reload — this proves the WebSocket upgrade path, not just plain HTTP
   forwarding.
6. **Auth and re-scan edge cases (curl, second terminal).**
   - `curl -si http://127.0.0.1:7433/proxy/<sid>/<port>/` with no
     credentials at all → `401`.
   - The same request with a valid `?puddle_token=` but a port number the
     session does not own → `403`.
   - Kill the dev server and restart it on a **different** port, then
     immediately (no waiting for a poll) request
     `.../proxy/<sid>/<new-port>/?puddle_token=<token>` → succeeds on the
     first try (`PortScanner.hasPort`'s one-shot re-scan means there is no
     403 window waiting for the next 5s poll).
7. **Upstream token hygiene.** Run the dev server with request logging (Vite
   `--debug`, or point the proxy at a throwaway `nc -l <port>` upstream and
   watch the raw request line) and hit the proxy once more with
   `?puddle_token=` in the query string: the forwarded request line the
   upstream sees never contains `puddle_token` — only the daemon's own
   `puddle_proxy` cookie is stripped from what's forwarded, and the token
   query pair never reaches the dev server at all.
8. **Second tab, already-bootstrapped.** Open a second browser tab (same
   browser profile, so the `puddle_proxy` cookie already exists) directly at
   `/proxy/<sid>/<port>/` with no token in the URL: it reaches the app
   immediately — no bootstrap redirect needed, since the cookie already
   authenticates it.
9. **Session teardown.** Kill the session from the sidebar: the ports strip
   disappears (no live session to poll), and
   `GET /api/sessions/:id/ports` for that id returns `{ "ports": [] }`.
10. **Daemon shutdown with a proxied WS open.** With the HMR tab from step 5
    still open and its WebSocket connected, stop the daemon
    (`kill` the `node packages/daemon/dist/index.js` process, or
    `systemctl --user stop puddled` in a real deployment): the process exits
    cleanly (no hang waiting on the proxied socket) within a few seconds.

Record any UI/daemon mismatches found here as issues; adapter corrections
still go to the relevant file under `packages/daemon/src/agents/` per
phase-1.
