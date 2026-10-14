# puddlang — agent scripting

Status: initial slice implemented, revised 2026-10-14. The name **puddlang** is
chosen. [The usage guide](../puddlang.md) and [working example](../../examples/puddlang/review.ts)
describe the implemented interface. The broader design below includes deferred
features and illustrative spellings; it is not a claim of full implementation.

## Implemented first slice

- Single-file TypeScript with spawn, attach, exact ask, Zod validation and stop;
  **Codex 0.159.0+ only** for now.
- Daemon-owned runners, SQLite runs/events, idempotent submissions, bounded
  turns/agents/lifetime, explicit cancellation and interruption on restart.
- Existing registered project/worktree roots and canonical path lookup;
  profile-scoped account selection with no fallback from unavailable defaults.
- Bundled CLI: run, context, status, logs, cancel, mcp. Run waits by default;
  use `--detach`. Output is JSON; `--wait`, `--json` and `logs --follow` in the
  sketches below are not implemented.
- Stdio tools: puddlang_context, puddlang_run, puddlang_status, puddlang_events,
  puddlang_cancel, through existing local/SSH authority.

Deferred: other adapters, direct agent MCP tools, automatic agent MCP binding,
delegated credentials, parent/child budgets, arbitrary directory registration,
worktree creation, durable continuation, scheduling and the run inspector UI.
Use two Codex agents initially; mixed-agent examples below describe extensions.
Live TUI/SSH acceptance is separate from automated fake-agent coverage.

## Outcome

Let a user write a short program that starts agents, sends them messages, and
passes their replies to other agents. The first use case is a coder and a
reviewer: the coder implements a task, the reviewer inspects the result, and the
coder addresses the feedback until the reviewer declares the work complete.

Both agents retain their own native conversations across iterations. They are
ordinary Puddle agents, visible in the cockpit, with their terminals and history
available for inspection and human intervention. Each agent can start in a
specified project and worktree, or at a filesystem path on the host.

The script routes messages and controls execution. The agents do the reasoning.
A separate coordinator agent is optional; the two-agent review loop does not
need one.

## Programming model

The core operations are:

| Operation                              | Meaning                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `spawn(options)`                       | Start an agent at the selected location and return a handle.             |
| `agent.ask(message)`                   | Submit an instruction and await that turn's completed reply.             |
| `agent.ask({ prompt, input, schema })` | Supply explicit input and request a reply validated against a schema.    |
| `agent.stop()`                         | End the agent's live execution, retaining its history and working files. |
| `attach(reference)`                    | Obtain the same kind of handle for an existing managed agent.            |

Spawning an agent and attaching to an existing agent converge on the same
interface. A workflow is a program over these handles; an agent may be created
by the script, selected from the cockpit, or passed into the program. Ownership
and existing activity affect lifecycle policy, rather than the available
message operations.

Start by proving these operations through a small TypeScript API. Ordinary
variables, loops, functions and promises already express the first workflows.
A dedicated grammar remains an option once examples show which syntax would
help. The proposed first frontend uses TypeScript files, so calling the runtime
puddlang does not require a parser before the core operations work. CLI and MCP
interfaces should expose the same underlying capabilities.

## Running puddlang

Use a `pudl` executable distributed with the Puddle CLI. It reuses the
CLI's local/SSH connection, handshake and authority implementation. Example
commands, using the initial TypeScript frontend:

```sh
pudl run review.ts --profile personal
pudl run review.ts --host user@devbox --profile personal
pudl run review.ts --profile personal --wait --json
pudl run review.ts --profile personal --account codex=primary --account claude-code=review
pudl status <run-id> --profile personal
pudl logs <run-id> --profile personal --follow
pudl cancel <run-id> --profile personal
```

Every run command accepts the same host/profile selectors. Omitted host means
local outside a managed context; inside an agent, inherit its verified host
context. Record resolved host and profile identities with the run so later
inspection never silently targets another host with a matching display name.

`run` submits a program and returns a run id after acceptance. `--wait` also
follows it to a terminal outcome; ending that wait detaches the observer.
`cancel` explicitly stops further execution under the run's cleanup policy.
Machine output distinguishes acceptance, completion, failure, cancellation and
interruption. A later inspection can obtain results without submitting again.
Repeated `--account <agent>=<account>` options set run defaults; an explicit
account in a spawn call takes precedence.

The daemon supervises a separate runner process on the selected host. The
program and its agents execute there; the client can disconnect after accepted
submission while a supervised daemon remains available. An SSH-attached
fallback daemon retains its existing cockpit lifetime, so it cannot promise
continued execution when that cockpit closes.

The script filename is local to the invoking CLI. Submit a captured source
bundle and explicit inputs to the host, recording their version/hash. Agent
`path` and worktree arguments refer to the target host. Dependency bundling and
available imports need an explicit contract; do not assume a laptop's files or
installed packages exist on a remote host. Never evaluate user programs on the
daemon's event loop. The first frontend executes trusted code with the host OS
user's authority; a separate process is not a security sandbox.

Require an existing daemon when invoked inside an agent. Connecting to Puddle
must not launch `puddled` from the agent's inherited orchestration environment.

## Agents using puddlang, and MCP

An agent can orchestrate workers through either interface:

1. Write a script and invoke `pudl run ... --json` using its shell tool.
2. Call a puddlang MCP server to submit a program or operate agent handles
   directly. A coordinator need not generate source code to ask one reviewer.

Propose `pudl mcp --profile personal` as a stdio server, with `--host`
available for external clients targeting an SSH host. It is a client of the
same host service as the CLI. A remotely hosted HTTP MCP endpoint would be a
later transport with its own authenticated delivery design.

| Proposed MCP tools                                                               | Purpose                                                                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `context_get`, `projects_list`, `worktrees_list`, `accounts_list`, `agents_list` | Discover the bound host/profile, available locations, accounts and adapter capabilities. |
| `runs_start`, `runs_get`, `runs_events`, `runs_cancel`                           | Submit captured source and inputs, inspect progress/results, and cancel a run.           |
| `agents_spawn`, `agents_attach`, `agents_ask`, `agents_stop`                     | Drive the same handles as a script, without writing a program.                           |
| `requests_get`                                                                   | Retrieve the state and eventual result of a submitted turn.                              |

Long operations return a run or request id promptly. `agents_ask` can return a
request id to MCP while the TypeScript `ask` wrapper awaits that same request.
Bounded event/result reads avoid holding a single tool call open for an entire
review loop. An expired tool call must never cause automatic resubmission.
Submission keys and host records are needed to reconcile uncertain outcomes.
Source passed to `runs_start` is inline or an explicitly uploaded bundle; an
external MCP client's local filename is not a host filesystem path.

An agent already managed by Puddle should inherit its host, profile and caller
runtime context. Provide the MCP configuration through that agent's adapter
and Puddle-owned account configuration, using per-runtime binding where
supported. Environment ids are routing hints only: the daemon must authenticate
the caller and validate delegated scope through a separate control resource.
Do not reuse the lifecycle signal nonce or expose the host master credential.
External agents receive an explicitly configured host/profile connection.

Record parent run/runtime relationships so the cockpit can show who spawned
which worker. Further delegation uses the same operations, with descendants
sharing the root run's configured concurrency, turn and lifetime limits. An
agent may inspect its own context, but asking its own active turn or creating a
cyclic wait must be rejected or surfaced without hanging indefinitely.

A small usage guide or agent skill can teach these operations. It is onboarding
for the shared API, rather than an independent orchestration implementation.

## Profiles, accounts and scope

A run has one host and one Puddle profile. Select the profile through explicit
CLI configuration, the cockpit that starts the run, or the verified parent
agent context. Outside those contexts, an interactive CLI may offer a picker;
unattended calls fail clearly if the selection is ambiguous. Never read a
browser's last-selected profile as an implicit automation identity.

All projects, account lookups, handles and run records belong to that scope.
Resolve a path only against projects in the selected profile; the filesystem
path itself does not identify a profile. A mismatch produces an error. The
same checkout may legitimately have placements under several profiles.

An account selects the agent's configured login within that profile. Each spawn
can choose a different account:

```ts
const coder = await spawn({
  agent: 'codex',
  account: 'primary',
  project: 'app',
  worktree: 'feature/search',
});

const reviewer = await spawn({
  agent: 'claude-code',
  account: 'review',
  project: 'app',
  worktree: 'feature/search',
});
```

Resolve account labels within `(host, profile, agent type)` and retain their
ids. Proposed selection order:

1. An explicit account id or label, validated against the requested agent.
2. An explicit per-agent default supplied for this run.
3. The profile's existing default account, if it matches the requested agent.
4. The sole eligible account for that agent in the profile.
5. Otherwise, return the available choices and require a selection.

An explicitly selected or configured default account that is logged out or
unavailable produces an error; do not silently charge another account. Once
selected, keep the account fixed across replies and recovery. Account migration
or quota-driven fallback must be explicit. Attaching retains the running
agent's account and conversation; it does not change billing identity.

The agent authenticates through its existing Puddle-managed account directory.
Scripts receive account references and public metadata, never agent login
secrets. Existing permission gates and account opt-ins apply to every spawn,
resume and migration. MCP bindings and delegated callers cannot widen their
profile scope by supplying a different `profile` field.

These are application boundaries. Profiles still share the OS user and its
filesystem authority, including for TypeScript runners and shell-capable
agents; they are not isolation against malicious local code. A human with
host-wide local/SSH authority can deliberately start a separate run in another
profile. Multi-profile or multi-host coordination can later compose explicit
connections without weakening the scope of an existing handle.

## First example: implement, review, revise

This sketch assumes `spawn` is supplied by the proposed API. `Review` is a Zod
schema used to validate the reviewer's result at runtime.

```ts
import { z } from 'zod';

const Review = z.object({
  complete: z.boolean(),
  feedback: z.string(),
});

const location = { project: 'app', worktree: 'feature/search' };
// Alternatively: { path: '/srv/app' }

const coder = await spawn({ agent: 'codex', ...location });
const reviewer = await spawn({ agent: 'claude-code', ...location });

let instruction = 'Implement search';

while (true) {
  const result = await coder.ask(instruction);

  const review = await reviewer.ask({
    prompt:
      'Review the implementation against the original task. Inspect the changes ' +
      'and verify the result. If anything remains, return actionable feedback.',
    input: { task: 'Implement search', result },
    schema: Review,
  });

  if (review.complete) break;
  instruction = review.feedback;
}
```

The coder remembers its implementation and previous revisions. The reviewer
remembers earlier findings and receives the original task as well as the latest
reply. It can inspect the actual changes and run checks in its working directory;
the coder's summary alone is not evidence that the task is complete.

The loop ends on a validated `complete: true` result. Reaching an optional turn
limit, encountering an error, or cancelling the run produces a distinct outcome.
Approval ends this program; committing, merging or publishing would be explicit
additional script operations. Final agent cleanup is a lifecycle policy to
resolve, so the example leaves both agents available for inspection.

## Choosing where agents run

Support two location forms on `spawn`:

- **Project and worktree:** select a Puddle project and a particular worktree of
  its repository. The example's names are conveniences; durable records should
  retain resolved identities and canonical paths. Ambiguous names must produce
  an explicit error.
- **Path:** start in an existing host directory, such as `/srv/app`. This must
  work through local and SSH access with the same meaning: the path is on the
  machine running the agent, not necessarily the client machine.

The coder and reviewer can use the same location or different locations. In the
first example they deliberately share a worktree and take turns, so the reviewer
sees the coder's current files, including uncommitted edits. Sequential calls
coordinate these two agents; they do not lock out humans or unrelated agents.

When agents use separate worktrees, passing a reply does not transfer files.
The program needs an explicit patch, commit or snapshot hand-off before a
reviewer can inspect the same changes. Parallel testing and review should use
a defined snapshot when other work may continue.

Selecting an existing worktree and creating a new one need distinct semantics.
The example selects an existing directory. The eventual creation API should
reuse Puddle's worktree management and its repository-wide Git mutex.

Raw paths need an explicit integration decision: current Puddle placements
belong to a project and canonical worktree. Resolve an unambiguous existing
mapping where possible, and define what happens for unregistered repositories,
subdirectories, non-Git directories and paths shared by multiple projects. The
path form is part of the intended interface; its backing data model is open.

## What `ask` promises

An `ask` call identifies one submitted instruction and returns that turn's
reply. It must distinguish completion from a permission request, interruption,
process exit, or transport failure. A quiet terminal or `waiting_input` status
alone cannot establish that the requested reply exists.

Unstructured calls return the reply text. Structured calls return validated
data. Prompting an agent to produce JSON is only one part of that contract:
Puddle must correlate the response to the request, extract it, and validate it.
Invalid output must remain an error or an explicit bounded repair attempt;
never interpret it as approval. Exact result envelopes and repair defaults
remain to be designed.

Keep three outcomes distinct:

1. The agent started and accepted an instruction.
2. The agent completed a turn and produced a reply.
3. The task met the program's completion condition, such as reviewer approval
   and any separately required checks.

Agent-specific message submission, turn boundaries and response extraction
belong in adapters. Their support must be capability-checked against the
installed agent. Existing lifecycle hooks and native synchronisation are useful
foundations, but do not yet establish the proposed `ask` contract. Catalogue
discovery must remain metadata-only; reply extraction needs a separate,
explicitly bounded mechanism.

## Execution and human control

The desired experience is that a user can watch either agent, pause the script,
intervene, and continue. Human input must not silently race an automated turn
or become the reply to a different request. The precise pause, takeover and
resume interaction remains open.

Define execution policies for:

- **Busy agents:** queue a new request, reject it, or interrupt only when
  explicitly requested. Never silently overwrite existing work.
- **Ownership:** record whether a run spawned or attached to an agent. Stopping
  a script and stopping its agents are separate actions; attached agents need
  an explicit cleanup policy.
- **Bounds:** optional turn limits, deadlines and cancellation, with outcomes
  visible in the cockpit.
- **Recovery:** retain request identities and recorded results so reconnecting
  can discover what happened. Never blindly replay an instruction or spawn
  whose delivery is uncertain.

Use the host-owned execution described above. Persisted run and step records
are a likely foundation, distinct from Puddle placements,
native conversations and live runtimes. Durable execution of arbitrary
TypeScript requires a runner design; saving a run record alone does not make
JavaScript continuations resumable. A first prototype may stop explicitly on
restart while that recovery contract is developed. Accepting a run creates
daemon-owned work; an observer's connection lease remains separate and is
never silently renewed to keep that work alive. Reconnecting requires fresh
authority before observing or changing the run.

## Fit with Puddle

Reuse the existing daemon, managed accounts, session creation, PTYs and worktree
services. A script's agent handle should resolve through live runtime ownership,
while keeping placement and native conversation identity explicit. Native
clear/resume/fork transitions require a defined policy for pending requests;
an immutable placement id alone cannot serve as the live agent identity.

Likely implementation seams:

- `packages/daemon/src/sessions/`: managed spawning, runtime lookup and lifecycle
  integration. Keep script runs separate from session rows.
- `packages/daemon/src/agents/`: capability checks, submission, turn correlation
  and reply extraction for each supported agent.
- `packages/daemon/src/worktrees/`: directory resolution and any explicitly
  requested worktree creation or snapshot operations.
- `packages/shared/`: validated request, reply and run-state protocol shapes.
- `packages/cli/`: the `pudl` executable and MCP bridge, reusing shared
  connection libraries. Business logic stays in host services.
- `packages/web/`: run inspection and controls, with agents visible in the
  existing cockpit.

Scripts use the existing connection authority and profile boundaries. They do
not gain access through terminal icon detection, inherit host master credentials,
or bypass normal account and permission settings. Remote operations will need
the usual connector allowlist and profile-access review.

This draft adds no endpoint, database schema or protocol change. Implementation
must update [SPEC](../../SPEC.md), adapter conventions and the changelog, with
shared protocol versioning and database migrations where required.

## First implementation slice and open questions

Prove the two-agent loop through the CLI on one host with existing worktrees,
persistent conversations, exact replies and a visible result. Exercise both
location forms once their project mapping is defined. Add the MCP bridge and
attaching through the same host operations, then extend execution controls and
recovery. Scheduling, automatic integration and a custom grammar can follow
demonstrated need. The initial slice does not establish full Superset parity.

Before implementation, resolve:

1. Which adapters can provide reliable turn submission and replies, and how do
   unsupported versions report that limitation?
2. How does a raw path map into the current placement model, and which durable
   project/worktree selectors supplement display names?
3. How are source dependencies bundled, runner imports constrained, and
   pending requests recovered after a runner or daemon restart?
4. How is per-runtime delegated control bound across adapters without changing
   another concurrent runtime's MCP context?
5. What are the defaults for busy agents, human takeover, invalid structured
   replies and agent cleanup?

Acceptance should demonstrate repeated revision followed by approval, rejection
of malformed approval data, a blocked permission request, cancellation or a
turn limit, and interruption without duplicate submission. Verify that shared
worktrees expose uncommitted changes and that separate worktrees require an
explicit transfer. Add CLI/MCP equivalence, profile mismatch, ambiguous account,
logged-out default, and parent/child scope tests. Use deterministic fake agents
for automated tests, then record real-agent acceptance against pinned versions.

## Superset comparison and remaining gaps

Puddle does not currently offer everything documented by Superset. The proposed
loop covers a useful orchestration pattern, but a scripting language alone
does not supply integrations or product features. This comparison uses official
documentation reviewed on 2026-10-14 and the current Puddle implementation;
it is a feature comparison, not an end-to-end operational benchmark.

| Capability                                                             | Current Puddle position and remaining work                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent agents, worktrees, terminals, editor, diffs and port access | Existing foundation; the CLI/MCP scripting bindings still need implementation. [Superset overview](https://superset.sh/).                                                                                                                                                                                                                                                                                                                           |
| Agent-control CLI, SDK and MCP                                         | Puddle's CLI currently centres on host/cockpit management, attach and logs. Add discovery, spawning, structured turn requests, inspection and control. Superset already exposes [CLI operations](https://docs.superset.sh/cli/cli-reference), a [TypeScript SDK](https://docs.superset.sh/sdk/reference) and [MCP tools](https://github.com/superset-sh/superset/blob/main/apps/docs/content/docs/mcp-server.mdx). Its SDK is labelled early alpha. |
| Transcript reads, state waits, resume, fork and hand-off               | Puddle has status, native conversation lifecycle, resume and account/agent continuation foundations. It lacks a unified scripting surface and exact request/reply contract. Superset documents reads, waits, diagnostic state explanations and capability-dependent resume/fork in its [CLI](https://docs.superset.sh/cli/cli-reference).                                                                                                           |
| Supported agents and launch configuration                              | Puddle has four managed adapters: Claude Code, Codex, OpenCode and Gemini CLI. Other CLIs can run in terminals. Superset documents [more integrations](https://docs.superset.sh/supported-agents), with varying depth. More adapters and capability-checked model/effort controls are separate work.                                                                                                                                                |
| Scheduled runs                                                         | No general agent scheduler in Puddle. Superset has [recurring automations](https://docs.superset.sh/automations). Add persisted schedules, timezone handling and run history later. External cron could invoke `pudl` sooner, but would not provide the same product experience.                                                                                                                                                                    |
| Setup, teardown and reusable terminal commands                         | Puddle has agent-led onboarding notes and shell terminals. Superset has explicit [project lifecycle commands](https://docs.superset.sh/setup-teardown-scripts) and saved terminal launches. Equivalent lifecycle hooks and command bindings need their own design.                                                                                                                                                                                  |
| Task tracking and external integrations                                | No integrated task board, issue-sync or Slack workflow in Puddle. Superset has [tasks and issue delegation](https://docs.superset.sh/tasks) and [Slack integration](https://docs.superset.sh/use-with-slack).                                                                                                                                                                                                                                       |
| Pull-request workflow                                                  | Puddle has local Git inspection and mutations. Superset has a [GitHub PR dashboard](https://docs.superset.sh/pull-requests) with checks, comments and merge actions. Agents invoking external tools would not amount to the same built-in feature.                                                                                                                                                                                                  |
| Browser and desktop automation                                         | Puddle has file previews and forwarded service links. Superset has an [embedded browser with inspection and automation](https://docs.superset.sh/browser) and a [computer-control skill](https://docs.superset.sh/computer) using separately installed third-party drivers. These are additional integrations.                                                                                                                                      |
| Collaborative reports                                                  | Puddle has local document previews and a scratchpad. Superset [Pages](https://docs.superset.sh/pages) adds hosted versions, sharing and comments routed back to agents. No equivalent publishing service exists here.                                                                                                                                                                                                                               |
| Remote, team and mobile access                                         | Puddle has first-class SSH and a self-hosted relay/mobile web UI. Superset's [remote access](https://docs.superset.sh/remote-access) includes organisation host membership and a native iPhone/iPad client. These are different access models, not interchangeable profile semantics.                                                                                                                                                               |
| Cloud and project-free workspaces                                      | Puddle runs on user-managed hosts and its placements require projects. Superset documents [cloud workspaces in early access and scratch workspaces without projects](https://docs.superset.sh/workspaces). Hosted compute and project-free placement are separate gaps; path targeting alone does not resolve them.                                                                                                                                 |

For closer orchestration coverage, extend the small core with location and
agent discovery, explicit worktree creation, bounded transcript/event reads,
state waits, terminal/command operations, snapshots and capability-checked
resume/fork/hand-off. Scheduling is a further service around the same runtime.
The task, PR, browser and publishing features remain separate product work.

Superset's default `agents wait` state can mean a finished turn or a request for
input; its automation success means workspace creation, not successful task
completion. Puddlang's proposed `ask` and validated reviewer decision need their
own stronger contracts. This is an implementation objective, not an already
delivered advantage. See the [CLI](https://docs.superset.sh/cli/cli-reference)
and [automation limits](https://docs.superset.sh/automations).

The [coordinator recipe](https://docs.superset.sh/orchestration) remains useful
design context. No external implementation is copied.
