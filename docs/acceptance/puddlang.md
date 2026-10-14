# puddlang acceptance

Use a plain shell, disposable registered repository and logged-in Codex account.
These checks invoke real agents and may consume usage. Fake-agent tests and schema
generation do not establish live TUI compatibility.

1. Build/install CLI and daemon. Check `puddlang --help` and `context --profile`:
   only that profile's public project/account metadata should appear.
2. Run `examples/puddlang/review.ts` on a small task. Confirm two normal placements
   in the selected worktree, visible turns and validated reviewer approval.
   Approve native permission requests in the terminal: the CLI must keep waiting
   at a permission prompt.
3. Inspect `status`/`logs` after CLI exit. Resubmit identical work with the same
   `--id`: no extra turns or agents. Different work with that id must conflict.
4. Repeat with SSH, a client-local script and host-local worktree. Detach,
   reconnect and inspect the same run.
5. Cancel during an ask: owned agents stop, work/history remain. Repeat using
   `attach`: the pending turn stops while the existing agent remains available.
6. Submit human input or switch native conversation during an ask. Confirm failure
   without attributing the new reply to the old turn. Busy agents must reject
   concurrent asks; invalid structured output must fail.
7. Restart the daemon mid-run. Confirm `interrupted` and no instruction replay
   when ordinary sessions resume.
8. Configure `puddlang mcp --profile <name>` in an external agent. Discover tools,
   submit inline source with a UUID, read results/events, cancel. Disconnecting
   MCP must not cancel accepted work.
9. Test unavailable accounts, ambiguous paths/projects, unsupported adapters and
   Codex below 0.159.0/fallback native sync. Expect explicit errors, no fallback.

Live Codex and SSH acceptance remains pending until exercised on an authorised
test host. Do not mark these checks passed from unit tests alone.
