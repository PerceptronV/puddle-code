# Phase 1 acceptance — daemon core (curl + wscat, real claude)

SPEC §14 Phase 1 acceptance, run manually against a real Claude Code install.
The automated equivalent (with a deterministic fake agent) lives in
`packages/daemon/test/e2e.test.ts` and runs in CI; this script exists to
verify the pieces CI cannot: real `claude` flags, its TUI status patterns,
and the systemd/launchd restart path.

Prerequisites: `pnpm build`; a git repo with a remote at `~/src/my-repo`;
Claude Code ≥ 2.1.207 on PATH.

```sh
export PUDDLE_HOME=~/.puddle          # or a scratch dir for a clean run
node packages/daemon/dist/index.js &  # or via the systemd/launchd unit
TOKEN=$(cat $PUDDLE_HOME/token)
AUTH="Authorization: Bearer $TOKEN"
API=http://127.0.0.1:7433/api
```

1. **Token enforcement.** `curl -si $API/version` → 401.
   `curl -si -H "$AUTH" $API/version` → 200. A wrong `Host:` header → 403.

2. **Setup.**
   ```sh
   curl -s -H "$AUTH" -X POST $API/profiles -d '{"name":"alice","branch_prefix":"alice/"}'
   curl -s -H "$AUTH" -X POST $API/accounts -d '{"profile_id":1,"agent_type":"claude-code","label":"personal"}'
   curl -s -H "$AUTH" -X POST $API/accounts -d '{"profile_id":1,"agent_type":"claude-code","label":"org"}'
   curl -s -H "$AUTH" -X POST $API/repos    -d "{\"path\":\"$HOME/src/my-repo\",\"onboarding_notes\":\"always pnpm install\"}"
   curl -s -H "$AUTH" -X POST $API/projects -d '{"profile_id":1,"repo_id":1,"name":"demo"}'
   ```

3. **Login both accounts.** For each account id:
   `curl -s -H "$AUTH" -X POST $API/accounts/1/login` → `{"stream":"login-1","term":"agent"}`;
   attach with wscat (below) and complete the OAuth flow. `GET $API/accounts?profile=1`
   shows `logged_in: true` afterwards. Confirm `$PUDDLE_HOME/profiles/alice/accounts/claude-code/…`
   received the agent state — never `~/.claude`.

4. **Closed gate.** `curl -si -H "$AUTH" -X POST $API/sessions -d '{"project_id":1,"account_id":1,"skip_permissions":true}'`
   → 400 `skip_permissions_denied`.

5. **Two sessions on two accounts.**
   ```sh
   curl -s -H "$AUTH" -X POST $API/sessions -d '{"project_id":1,"account_id":1,"title":"task one","prompt":"summarise the README"}'
   curl -s -H "$AUTH" -X POST $API/sessions -d '{"project_id":1,"account_id":2,"title":"task two","prompt":"list the test files"}'
   ```
   Attach two wscat windows (send each line as one message):
   ```
   wscat -c ws://127.0.0.1:7433/ws
   > {"t":"auth","token":"<TOKEN>"}
   > {"t":"subscribe-status"}
   > {"t":"attach","session":"<id>","term":"agent","cols":120,"rows":32}
   ```
   Expect interleaved `output` from both sessions; each begins with the
   `[puddle onboarding]` preamble (containing "always pnpm install") followed
   by the task prompt. Watch `status` messages flip `running ⇄ waiting_input`
   as claude works and idles — **verify the adapter's `statusPatterns` against
   what you see and adjust `agents/claude-code.ts` if the TUI changed.**

6. **Restart / reconcile.** `systemctl --user restart puddled` (Linux) or kill
   and relaunch the process. `GET $API/sessions?project=1` → both `interrupted`.

7. **Resume.** `curl -s -H "$AUTH" -X POST $API/sessions/<id>/resume` for each.
   Reattach: the `replay` message carries the pre-restart scrollback; claude
   resumes with history intact and receives the interruption note ("Processes
   you started are gone…"). Confirm the conversation JSONL lives at
   `<config_dir>/projects/<escaped-cwd>/<session-id>.jsonl`.

8. **Onboarding notes sync.** In one session, tell the agent: "from now on,
   always run pnpm lint before finishing". Once it writes
   `.puddle/onboarding-notes.md`, `GET $API/repos` shows the updated
   `onboarding_notes`, and the session's events include
   `onboarding_notes_updated` with the previous text.

9. **Fresh-worktree-only preamble.** Kill one session and resume it: no second
   preamble (resume passes only the interruption note). (The tier-2 hand-off
   variant of this check lands with Phase 7.)

10. **Archive.** `POST $API/sessions/<id>/kill` then `/archive` → worktree dir
    gone, branch still in `git branch --list`, logs still under
    `$PUDDLE_HOME/logs/<id>/`.

Record any adapter corrections (status regexes, flag changes) in
`packages/daemon/src/agents/claude-code.ts` with the verified version number.
