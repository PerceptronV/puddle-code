# puddlang acceptance

Use a plain shell and disposable registered repository. Each selected agent needs
a logged-in account in the chosen profile.
These checks invoke real agents and may consume usage. Fake-agent tests and schema
generation do not establish live TUI compatibility.

1. Build/install CLI and daemon. Check `pudl --help` and `context --profile`:
   only that profile's public project/account metadata should appear.
2. Run `examples/puddlang/review.ts` on a small task. Confirm two normal placements
   in the selected worktree, visible turns and validated reviewer approval.
   The example defaults to an interactive Codex coder and scripted Codex reviewer;
   input keys `coder`, `reviewer`, `coderMode` and `reviewerMode` select others.
   Repeat with a mixed-provider pair. Confirm permission gates remain enforced:
   scripted mode never grants permissions merely because it is scripted.
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
8. Configure `pudl mcp --profile <name>` in an external agent. Discover tools,
   submit inline source with a UUID, read results/events, cancel. Disconnecting
   MCP must not cancel accepted work.
9. Test unavailable accounts, ambiguous paths/projects, unsupported adapters and
   agent versions below the usage guide's minima/fallback native sync. Expect explicit errors, no fallback.

10. For each cell below, send two turns and inspect native history. Confirm one
    exact native conversation across both asks, correct account isolation and cwd,
    and no attribution of subagent/tool text to the final reply. Stop/resume the
    placement, attach a new programme and ask again; the mode and conversation
    must persist. Resume an unused scripted placement too: no instruction should
    execute until the first explicit ask.
11. Interactive: start with a human draft, modify/interrupt a running ask, switch
    native conversation, and test startup onboarding before the first ask. New
    asks must not overwrite drafts or race onboarding. For hook-based adapters,
    permission-dialogue input rejects the ask as human takeover. Codex permission
    approvals remain native proxy requests. Add a Stop/AfterAgent continuation hook
    to verify the documented interactive boundary; scripted completion must wait
    for the whole invocation to finish.
12. Scripted: deny a tool, produce malformed/oversized output, hit a provider error,
    cancel with Ctrl+C and cancel a run while a child tool is active. Failure must
    stay explicit, children must terminate and a retained attached runtime must
    accept a later explicit ask. Terminating the transcript must stop its child.

| Agent | Version baseline | Interactive live acceptance | Scripted live acceptance |
| --- | --- | --- | --- |
| Claude Code | 2.1.300 | Pending | Pending |
| Codex | 0.159.0 | Pending | Pending |
| OpenCode | 1.18.10 | Pending | Pending |
| Gemini CLI | 0.53.1 | Pending | Pending |

Automated coverage exercises native protocol fixtures, generated hooks/plugin,
real transcript-driver subprocesses with fake CLIs, exact identity, bounds,
cancellation and session persistence. CLI help was checked for installed Claude
and Codex and the published OpenCode binary; Gemini's published 0.53.1 package
supplies hook/output types and flags. These checks do not establish authenticated
live-agent or SSH acceptance. Do not mark the matrix passed from unit tests alone.
