# Cockpit refresh acceptance — `puddle refresh` + the UI's connection banner (manual)

SPEC §10 "Refresh: replace a cockpit in one step". Run by hand from a **plain
terminal** (never from inside a coding-agent session — CLAUDE.md's `puddled`
env warning) against a real host; the interesting part is a genuinely broken
tunnel/cockpit, which CI cannot fabricate. The pieces that CAN be unit-tested
are: argument parsing and the `argvFor` round-trip (`test/args.test.ts`), and
the `POST /cockpit/refresh` control endpoint's auth/method/origin matrix plus
its deferred callback (`test/serve.test.ts`).

## 1. CLI refresh, local

```sh
puddle start                    # note the origin, e.g. http://localhost:7433
puddle refresh local
puddle list
```

- `refresh` prints "stopped the old cockpit for local", then the detached
  relaunch story, ending with the SAME origin as before.
- The browser tab from before the refresh still works after a reload.
- Sessions kept running throughout (`puddle status`).

## 2. CLI refresh, remote, after a real cut

```sh
puddle connect user@host
# now break it: drop the network / restart the remote box's sshd / pkill the
# forward — wait until the UI shows the "Connection to the daemon lost" banner
puddle refresh user@host
```

- Works even when `puddle list` showed the cockpit as `unverified`.
- If the daemon itself was down (host rebooted), refresh restarts it
  (the "installed but not running — restarting it" path) and sessions come
  back `interrupted` with resume buttons — the normal reconcile story.

## 3. UI-driven refresh

- With the banner showing (or any time via ⌘K → "Refresh connection"):
  click **Refresh connection**.
- The banner switches to "Restarting the cockpit — this page reloads when it
  is back…", the cockpit log (`~/.puddle/logs/cockpit-<target>.log`) shows
  "refresh requested from the UI — replacing this cockpit" followed by the
  new cockpit's startup, and the page reloads by itself on the same origin.
- Terminals reattach with their scrollback (log-tail replay) after the reload.

## 4. Failure modes stay honest

- Kill the cockpit process outright, then click the banner button in the dead
  tab: a toast says the cockpit did not accept the refresh and points at
  `puddle refresh` in a terminal.
- On a password/2FA host, break the master (`ssh -O exit user@host`) and
  refresh from the UI: the detached refresh cannot prompt, the poll times out
  with the "may need a terminal" toast, and a terminal `puddle refresh
  user@host` (which CAN prompt) completes the job.
