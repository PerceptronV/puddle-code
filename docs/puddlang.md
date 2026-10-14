# puddlang

Puddlang runs small TypeScript programmes that manage Puddle agents. Claude Code,
Codex, OpenCode and Gemini CLI support both **interactive** and **scripted** modes.
Both use the actual agent CLI, its selected account, tools, configuration and
native conversation history. Agents remain visible in the cockpit.

## Distribution and setup

`pudl` runs puddlang programmes and ships as a second command in `@puddle-code/cli`.
Standalone archives include both commands and Node; the public installer installs both launchers.
`puddle upgrade cli` and `puddle remove cli` manage them together. There is no
separate npm package or daemon. Desktop-only users install the CLI for the shell
and MCP commands.

The executable is `pudl`; programme imports remain `puddlang`. The installer
replaces its own former `puddlang` launcher when upgrading an existing installation.

When upgrading a standalone version that predates `pudl`, re-run the current
public CLI installer once to add its launcher: older embedded installers may
only install `puddle` or the former `puddlang` command. Subsequent upgrades manage
both commands together.

The host needs daemon protocol **23.1+ within major 23**, **Node 22.21.1+**, and
the selected agent installed and logged in through Puddle. Bundled releases supply Node.
Upgrade an older daemon with `puddle upgrade daemon [user@host]`. Start Puddle
from a plain shell: `pudl` connects to an existing daemon and never bootstraps
one from an agent environment.

Protocol 23.0 is an intentional major boundary. Update CLI/desktop, daemon and
any remote connector/application together. Remote transport protocol remains 3;
the existing launcher still requires approval before updating an older daemon.

```sh
pudl context --profile personal
pudl run examples/puddlang/review.ts --profile personal \
  --input '{"project":"app","task":"Implement search"}'
pudl run examples/puddlang/review.ts --host user@devbox --profile personal \
  --input '{"project":"app","task":"Implement search"}' --detach
pudl status <run-id> --profile personal
pudl logs <run-id> --profile personal
pudl cancel <run-id> --profile personal
```

Every command accepts `--host` and `--profile`. Host omission means this machine.
Profiles resolve on that host; multiple profiles without a selection are an
error. Local invocations may use `PUDDLE_PROFILE_ID` as a routing hint, which
grants no authority. A runner sets it for subprocesses; agent PTYs do not
automatically receive an MCP configuration.

`run` waits by default and prints the run record as JSON. `--detach` returns
after submission. The id is printed to stderr before submission, so a lost
response can be reconciled with `status`. Closing CLI/MCP detaches; `cancel`
is explicit. Logs are newline-delimited event JSON; `--after <sequence>`
continues a previous read. There is no `--follow` yet. Use the same host/profile
to inspect a run.

## Programme API

Imports are `puddlang`, `zod` and `node:` built-ins only. Source is one file,
at most 256 KiB, copied from the invoking machine to the execution host. Node
strips erasable TypeScript syntax; it does not type-check. Relative imports,
npm dependencies and syntax requiring transformation, such as enums, are
unsupported. Pass JSON with `--input` and import `input` from `puddlang`.
The default export becomes the stored result, at most 256 KiB.

```ts
import { spawn, attach, z } from 'puddlang';

const agent = await spawn({
  agent: 'codex',
  mode: 'scripted', // Omit for the normal interactive terminal.
  account: 'primary',
  project: 'app',
  worktree: 'feature/search',
});
// Alternatively: await spawn({ agent: 'codex', path: '/srv/app' });
const reply = await agent.ask('Implement search and run the relevant tests.');
const review = await agent.ask({
  prompt: 'Check the result against the original task.',
  input: { reply },
  schema: z.object({ complete: z.boolean(), feedback: z.string() }),
});
const sameAgent = await attach(agent.handle.runtime_id);
export default { review, handle: sameAgent.handle };
```

See [the two-agent example](../examples/puddlang/review.ts) for an independent
reviewer. `ask(string)` returns the correlated assistant reply. Structured `ask`
uses native output schemas where available (interactive Codex and scripted Claude)
or includes the schema in the prompt, then validates the returned JSON with Zod.
Invalid output is an error; there is no implicit repair/retry.

`spawn` selects an existing project by id or unambiguous name. `worktree` selects
an existing branch or absolute worktree path; omission selects the registered
clone. `path` must match exactly one registered canonical worktree root in the
selected profile. Subdirectories, non-Git directories, unregistered paths and
ambiguous mappings fail. Create worktrees in the cockpit first. Agents sharing a
worktree see the same uncommitted files; messages between different worktrees do
not transfer changes.

Account selection is: explicit spawn account, repeated CLI
`--account codex=primary` defaults, matching profile default, then the sole
logged-in account for that agent. An unavailable explicit/default account fails
without fallback. Labels are scoped to profile and agent type; numeric selectors
are account ids. Attaching retains the existing account.

`attach` accepts a live runtime id or its current placement id. Handles contain
stable `runtime_id` and `session_id` at attachment time. Operations resolve the
current placement and recheck profile ownership. Native conversation switches
and human turn/steer/interrupt reject a pending ask. Busy agents reject new asks.
Replies use exact native identities and prompt acknowledgements, never terminal
quietness or catalogue recency.

## Execution modes

Choose `mode` on each `spawn`, including Codex. Omission means `interactive`.
The choice is persisted with the placement and retained on resume or account
migration. `attach` retains the existing runtime's mode; it cannot convert one.
`pudl context` advertises supported modes; the installed version is checked when
starting a runtime. Unsupported versions or unavailable control channels fail
explicitly for Puddlang. Normal interactive launches may still use lifecycle
fallback without Puddlang turn control. Scripted launches never silently switch modes.

| Agent | Minimum version for Puddlang | Interactive reply source | Scripted command |
| --- | --- | --- | --- |
| `claude-code` | 2.1.300 | UserPromptSubmit + Stop/StopFailure hooks | `claude --print --output-format stream-json` |
| `codex` | 0.159.0 | Native app-server thread/turn events | `codex exec --json` |
| `opencode` | 1.18.10 | Plugin prompt/message ids + session completion | `opencode run --format json` |
| `gemini-cli` | 0.53.1 | BeforeAgent + AfterAgent hooks | `gemini --output-format stream-json --prompt …` |

Interactive mode keeps the native TUI, including its permission dialogues and
human composer. Codex submits through its existing app-server proxy. Other
adapters submit bracketed paste and require native acknowledgement of the exact
prompt hash and a unique turn marker. An existing draft or human input during an
ask rejects that ask; for these hook-based adapters, even responding to a
permission dialogue counts as human takeover. Inspect the terminal and explicitly
submit another operation once the native turn has finished. Unacknowledged
prompts fail after 15 seconds and are never resubmitted automatically.

Interactive completion follows the native hook/plugin boundary. In particular,
Claude Stop and Gemini AfterAgent hooks can run before another user-installed
hook requests continuation. Use scripted mode for workflows requiring completion
of the whole CLI invocation, including those additional hooks.

Scripted mode opens a readable transcript in the cockpit. Each ask starts a
native non-interactive CLI invocation; subsequent asks resume the **exact same
native conversation** under the same account. The transcript shows prompts and
assistant text; the native TUI/composer is absent. Ctrl+C cancels the current
turn. A reply requires both a successful structured native result and exit code
zero. Exit alone, quiet output and another conversation's reply cannot complete
an ask. Cancellation stops the active CLI process group and leaves an attached
runtime available for a later explicit ask.

Both modes retain Puddle's existing permission gate and selected account. Mode
selection never enables bypass flags. Headless permission requests cannot be
answered by typing into the transcript: use the account's permitted operations
or interactive mode. Native denials/errors fail the ask; a CLI waiting for
unavailable approval remains subject to the run deadline.

Native flag and protocol fixtures are checked against the versions above;
authenticated live-agent and SSH acceptance is tracked separately in
[the acceptance checklist](acceptance/puddlang.md). Primary contracts:
[Claude hooks](https://code.claude.com/docs/en/hooks),
[Claude headless](https://code.claude.com/docs/en/headless),
[Gemini hooks](https://geminicli.com/docs/hooks/reference/),
[Gemini headless](https://geminicli.com/docs/cli/headless/),
[OpenCode plugins](https://opencode.ai/docs/plugins/) and
[OpenCode CLI](https://opencode.ai/docs/cli/).

## Lifecycle and limits

The daemon supervises a separate runner and stores submissions, results and
bounded events in SQLite. Programmes are **trusted code with the host OS user's
authority**; process/profile boundaries are not a sandbox. Use absolute paths
for filesystem operations. Source, input, results and logs remain locally until
the profile is deleted; avoid embedding secrets in them.

Defaults are 50 asks, 8 spawned agents and a one-hour deadline. Change them with
`--max-turns`, `--max-agents`, `--timeout-ms`, within caps of 1,000 turns, 32 agents
and 24 hours. Agent limits count cumulative spawns. The host allows 16 active
runs; each run permits 64 pending/4,096 total operations and approximately 1 MiB
of console logs. Spawn waits up to two minutes for readiness. Await every operation.

Completed and failed programmes retain their agents. Explicit cancellation and
deadline expiry interrupt pending asks and stop agents the run created; attached
agents remain. `await agent.stop()` explicitly stops either kind. Worktrees and
history are retained.

States are `running`, `completed`, `failed`, `cancelled`, `interrupted`. Daemon
shutdown/restart interrupts programmes; continuations are not resumed and turns
are not replayed. Existing session recovery is independent. Supervised daemons
can outlive clients; an SSH-attached fallback daemon still ends with its cockpit.
Profile removal requires runs to finish.

`--id <UUID>` supplies an idempotent submission id. Repeating identical work
returns the existing run, including its terminal outcome. Different work with
the same id is a conflict. Uncertain turn deliveries are never retried implicitly.

## MCP and agent callers

Configure a stdio MCP server with a fixed host/profile, for example:

```json
{
  "mcpServers": {
    "puddlang": {
      "command": "pudl",
      "args": ["mcp", "--profile", "personal"]
    }
  }
}
```

Use an absolute command path if the client has a different `PATH`. The wrapper
depends on the agent; command/arguments are the same. Add `--host user@devbox`
for SSH. Authentication uses existing CLI host control; no pasted tokens.

The server implements [MCP 2025-06-18 stdio](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
with `puddlang_context`, `puddlang_run`, `puddlang_status`, `puddlang_events`,
`puddlang_cancel`. Run takes inline source, a caller-chosen UUID, optional input,
account defaults and limits, returning promptly. An agent can submit a reviewer
programme and poll its result, or write a file and invoke the CLI. Source uses
the same spawn/attach/ask API.

MCP initially uses host-wide local/SSH authority with an application-level
profile binding. Automatic agent registration, delegated runtime credentials,
direct agent tools, parent/child tracking and shared descendant budgets are
deferred. Nested CLI invocations create independent runs. There is no HTTP MCP
listener, remote-relay execution or run inspector UI yet.

## Development

Build with `pnpm build`; invoke `node packages/cli/dist/pudl.js --help`.
Daemon builds and standalone archives include the runner/API modules and Zod.
Archive smoke tests execute a TypeScript programme with both imports without
starting a daemon. `pnpm build:cli-tarball` packages
both commands and smoke-tests help without starting a daemon.

Automated tests use fake agents and isolated homes. [Manual acceptance](acceptance/puddlang.md)
covers all four agents, both modes and SSH; [the roadmap](roadmap/puddlang.md) records deferred work.
