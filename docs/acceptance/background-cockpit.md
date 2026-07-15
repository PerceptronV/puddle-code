# Background cockpit acceptance — detach, list, kill, proxy recovery (real ssh)

SPEC §10 "Cockpit lifecycle: background by default", run manually against a
real SSH host. The mechanics (registry round-trip, nonce verification, referer
recovery, argv shapes, tunnel announcement semantics) are unit-tested in CI
(`packages/cli/test/{registry,serve,tunnel,args}.test.ts`); this script exists
to verify what CI cannot: a real detach on your terminal, real ssh auth before
the detach, and terminal-close survival.

Prerequisites: `pnpm build`; an SSH host you can reach (key or password).

1. **Background connect.** `node packages/cli/dist/index.js connect user@host`.
   Any ssh prompt appears BEFORE the detach; then the bootstrap log streams,
   the URL prints, and the command **exits**. The browser opens and works.

2. **Terminal-close survival.** Close that terminal entirely. The UI tab keeps
   working (new terminals, file tree, git). `~/.puddle/logs/cockpit-user@host.log`
   holds the cockpit's timestamped output.

3. **List + identity.** In a new terminal: `puddle list` shows the cockpit as
   `running` with its pid and origin. `curl -sI <origin>/ | grep -i x-puddle-cockpit`
   matches the `nonce` in `~/.puddle/cockpits/user@host.json`.

4. **Idempotence.** `puddle connect user@host` again → reports the running
   cockpit's URL and exits; no second process (`puddle list` still shows one).

5. **Proxy recovery.** In a session on the host, start a Vite dev server (its
   build must use absolute `/assets/…` paths). Open its port via the ports
   strip ("open via proxy"): the page renders fully — no blank body, no
   "Failed to load module script … text/html" in the console. The network tab
   shows the stray asset requests answered 307 → `/proxy/<sid>/<port>/…`.

6. **Tunnel quiet.** Leave the cockpit idle past your network's NAT timeout
   (≥ 15 min). The log gains no "tunnel lost/restored" pairs (keepalives hold
   it); pulling the network cable briefly may log one honest pair.

7. **Kill.** `puddle kill user@host` → the pid is gone, `puddle list` says
   `no cockpits are running`, and sessions on the host survive
   (`puddle status user@host` still lists them).

8. **Foreground escape hatch.** `puddle connect user@host --foreground` stays
   attached; Ctrl-C stops it and removes its registry record.
