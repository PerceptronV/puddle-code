# Phase 2 acceptance — UI shell (manual, real browser)

SPEC §14 Phase 2 acceptance, run by hand against the built daemon. The pure
logic (theme generation, contrast maths, ui-state serialisation, debounce,
WS manager) is unit-tested in CI; this script verifies what needs eyes and a
real browser. Editor-tab clauses are deferred to Phase 3 with Monaco.

Setup:

```sh
pnpm build
export PUDDLE_HOME=$(mktemp -d)
node packages/daemon/dist/index.js &
until [ -f "$PUDDLE_HOME/token" ]; do sleep 0.2; done   # the daemon writes it on boot
open "http://127.0.0.1:7433/#token=$(cat $PUDDLE_HOME/token)"
```

First load: the token is captured from the fragment (the URL bar shows it
stripped), then the profile picker appears. Create a profile, then a project
against a real git repo, and add + login a claude-code account in Settings →
Accounts (the login terminal opens in-app; the account flips to "logged in"
when the OAuth flow completes).

1. **Workspace restore.** Open a project and start three sessions. Reorder
   their tabs by dragging, resize the sidebar, and pick a non-first active
   tab. Wait ~3 s (writes debounce at 2 s), kill the browser process, and
   reopen `/project/:id` → identical workspace: tab order, active session,
   pane sizes, and terminals replayed from the log tail. Layout follows the
   profile: a different browser (or a fresh tunnel port) under the same
   profile restores the same workspace, while a second puddle profile seeds
   from the snapshot but its rearrangements never clobber the first
   profile's row.

2. **Theme switch.** ⌘K → "Switch theme: light" (and back via Settings →
   Appearance): chrome and every open terminal restyle together with no
   reload, and ANSI colours in agent output visibly share the palette
   (khaki paper / deep hues vs storm-navy / pastels).

3. **Token guard.** `pnpm --filter @puddle/web check-tokens` passes; delete
   one semantic token from a theme block in `tokens.css` (or point
   `--status-running` at a pastel) and it fails naming the token and pair;
   restore the file.

4. **Permissions gate.** Settings → Permissions & safety: enabling the gate
   demands typing the profile name — the confirm stays disabled until it
   matches. Only with the gate open do per-account "skip prompts" toggles
   appear under Accounts, and only for opted-in accounts does the
   new-session modal show the per-session toggle. `curl` a
   `skip_permissions: true` create with the gate closed → the modal path is
   moot, but the API's 400 message renders verbatim if forced through the
   UI (close the gate between opening the modal and submitting).

5. **Account login.** Add a second account: the login terminal dialog opens
   automatically; after completing the flow the row shows "logged in".

6. **Interrupted resume.** Kill and relaunch the daemon. Session rows show
   interrupted (coral dot), the terminal pane shows the interrupted banner,
   and one click on Resume replays the scrollback and continues the
   conversation with the injected interruption note.

7. **Status ripples.** A running session's dot emits slow green concentric
   ripples; waiting_input pulses amber and the count appears in the browser
   tab title (`● n waiting`). With OS reduced motion on (or Settings →
   Appearance → Reduced motion), both become static dots.

Record any UI/daemon mismatches found here as issues; adapter corrections
still go to `packages/daemon/src/agents/claude-code.ts` per phase-1.
