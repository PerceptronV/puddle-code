# Captured session environment acceptance — transparent `export` persistence (manual, real browser)

SPEC §4 "Captured session environment". Run by hand from a **plain terminal**
(never from inside a coding-agent session — CLAUDE.md's `puddled` env warning)
against a real daemon with real shells; the interesting parts are real zsh/bash
startup-file chaining and user prompt frameworks, which CI approximates but
cannot exhaust. What IS unit-tested in CI: the OSC 7733 parser/strip
(`test/pty.test.ts`), the hook scripts against real zsh/bash PTYs
(`test/shell-env-hooks.test.ts`), merge/caps/injection/toggle
(`test/session-service.test.ts`), the REST round-trip and a full
capture→resume→inject loop (`test/e2e.test.ts`).

## Setup

```sh
pnpm build && pnpm build:tarball
export PUDDLE_HOME=$(mktemp -d)
node packages/cli/dist/index.js start --tarball dist-release/puddled-v*.tar.gz --foreground
# open the printed URL, add a profile/account/repo/project, start an agent session
```

## Steps

1. **zsh capture.** In the session, open a shell tab. Run
   `export ACC_TOKEN=secret-123`. Within ~5 s the `env` strip appears under the
   pane listing `ACC_TOKEN` (name only; hover shows its byte size).
   `curl -H "Authorization: Bearer $(cat $PUDDLE_HOME/token)" localhost:7434/api/sessions/<sid>/env`
   returns `{"vars":[{"name":"ACC_TOKEN","bytes":10}]}` — **no value**.
2. **New shell tab sees it.** Open a second shell tab; `echo $ACC_TOKEN` prints
   `secret-123`.
3. **Agent restart carries it.** Kill the session, resume it, then
   `ps eww <agent pid> | tr ' ' '\n' | grep ACC_TOKEN` shows the var in the
   agent process env.
4. **Daemon restart.** Restart the daemon (`Ctrl-C`, start again). The session
   comes back `interrupted`; resume it — the injected var is still there.
5. **`source` and multiline values.** In a shell tab:
   `printf 'export MULTI="a\nb \\"q\\""\n' > setenv.sh && source setenv.sh`.
   The strip lists `MULTI`; in a fresh shell tab `printf %s "$MULTI" | xxd`
   shows the value byte-exact (embedded newline and quotes intact).
6. **Unset.** `unset ACC_TOKEN` at a prompt: within ~5 s the strip drops it,
   and a fresh shell tab no longer sees it.
7. **Secrets never hit the logs.** `grep -r "secret-123" $PUDDLE_HOME/logs/`
   finds nothing (the typed command line echoes as keystrokes, so grep for the
   *value via the hook*: also check `grep -r "7733" $PUDDLE_HOME/logs/` — no
   OSC 7733 sequence is ever recorded).
8. **UI clear.** Session menu → "Clear captured env" → confirm. The strip
   empties; a fresh shell tab sees none of the vars.
9. **bash ≥ 4.** With `SHELL` pointing at a bash ≥ 4 when the daemon starts,
   repeat steps 1–2.
10. **Degradation.** With `SHELL=/bin/bash` (macOS 3.2) and with fish: the
    shell starts normally, prompts work, no errors printed, no vars captured.
11. **Prompt frameworks.** Under an oh-my-zsh or powerlevel10k user config:
    the prompt renders normally (no instant-prompt warning), and capture still
    works at each prompt.
12. **Toggle.** Settings → Sessions → "Capture exported env vars" off: new
    exports are not captured, new shells get no previously captured vars, and
    the strip hides. Toggling back on restores injection of the kept map.

Record mismatches in this file's PR or as issues; SPEC §4 is the contract.
