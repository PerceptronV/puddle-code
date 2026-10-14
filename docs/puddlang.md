# puddlang

Puddlang runs small TypeScript programmes that manage Puddle agents. The initial
version supports **Codex 0.159.0+**, with full native synchronisation. Agents
remain visible in the cockpit, using normal accounts, terminals and native
conversations. Other adapters cannot yet supply exact scripted replies.

## Distribution and setup

`puddlang` ships as a second command in `@puddle-code/cli`. Standalone archives
include both commands and Node; the public installer installs both launchers.
`puddle upgrade cli` and `puddle remove cli` manage them together. There is no
separate npm package or daemon. Desktop-only users install the CLI for the shell
and MCP commands.

When upgrading a standalone version that predates puddlang, re-run the current
public CLI installer once to add its launcher: older embedded installers only
install the `puddle` command. Subsequent upgrades manage both commands together.

The host needs daemon protocol **23.0+ within major 23**, **Node 22.21.1+**, and
Codex installed and logged in through Puddle. Bundled releases supply Node.
Upgrade an older daemon with `puddle upgrade daemon [user@host]`. Start Puddle
from a plain shell: puddlang connects to an existing daemon and never bootstraps
one from an agent environment.

Protocol 23.0 is an intentional major boundary. Update CLI/desktop, daemon and
any remote connector/application together. Remote transport protocol remains 3;
the existing launcher still requires approval before updating an older daemon.

```sh
puddlang context --profile personal
puddlang run examples/puddlang/review.ts --profile personal \
  --input '{"project":"app","task":"Implement search"}'
puddlang run examples/puddlang/review.ts --host user@devbox --profile personal \
  --input '{"project":"app","task":"Implement search"}' --detach
puddlang status <run-id> --profile personal
puddlang logs <run-id> --profile personal
puddlang cancel <run-id> --profile personal
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
reviewer. `ask(string)` returns final assistant text. Structured `ask` supplies
a native output schema and validates returned JSON with Zod. Invalid output is
an error; there is no implicit repair/retry. Native permission requests stay in
the terminal and keep the call pending.

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
Replies are correlated by native thread and turn ids, never terminal quietness.

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
      "command": "puddlang",
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

Build with `pnpm build`; invoke `node packages/cli/dist/puddlang.js --help`.
Daemon builds include the runner/API modules. `pnpm build:cli-tarball` packages
both commands and smoke-tests help without starting a daemon.

Automated tests use fake agents and isolated homes. [Manual acceptance](acceptance/puddlang.md)
covers live Codex and SSH; [the roadmap](roadmap/puddlang.md) records deferred work.
