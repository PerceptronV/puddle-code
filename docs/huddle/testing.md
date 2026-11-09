# Execute custom component fixtures

The authoring kit includes a standalone runner for trusted custom scripts, triggers
and readouts. It uses the real HuddleNode/HuddleTrigger/HuddleReadout wrappers,
contract validators, captured-import loader and puddlang client with scripted
fetch responses and agent replies. It needs Node 22.15+ and no running daemon,
account or huddle placement. [Validate](authoring.md) remains a separate command
that never evaluates project modules.

## Install the kit into a development huddle

`pudl huddle authoring` lists assets as JSON. Read each exact asset path to obtain
its `content`. Copy **all** `testing/` assets, including the generated `chunks/`
files, into the selected `.puddle/huddle/<huddle_id>/` directory. Reads themselves
do not write files. For example, this explicit extraction script refuses to
overwrite existing files:

```js
// Run with: node --input-type=module < extract-testing.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = '/absolute/worktree/.puddle/huddle/YOUR_32_HEX_ID';
const read = (args) => JSON.parse(execFileSync('pudl', ['huddle', 'authoring', ...args], {
  encoding: 'utf8', maxBuffer: 1024 * 1024,
}));
for (const { path } of read([]).files) {
  if (!path.startsWith('testing/') && path !== 'fixtures/executable.json') continue;
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, read([path]).content, { flag: 'wx' });
}
```

Install the pinned development dependency from `testing/package.json` with
`npm install --ignore-scripts --prefix /absolute/worktree/.puddle/huddle/YOUR_32_HEX_ID/testing`.
Keep its `node_modules/` out of version control. Do not install an npm package
named puddlang; the runner supplies that module. To update the kit, review and
replace its complete `testing/` set together, removing old generated chunks.

The shipped `fixtures/executable.json` matches `examples/feed-report.json` and
the transform/feed/report templates copied into `nodes/`. For an existing huddle,
adapt case node ids and inputs to its local components. The runner does not create
or overwrite a graph. Use the huddle's real random id in its manifest and directory.

```sh
node /absolute/worktree/.puddle/huddle/YOUR_32_HEX_ID/testing/run.mjs \
  --worktree /absolute/worktree --huddle YOUR_32_HEX_ID \
  --fixture fixtures/executable.json --timeout 10000
```

The JSON result contains the captured source revision, an overall `passed` value
and named case results with bounded errors/logs. Exit status is 0 only when every
case passes. `--timeout` is a per-case deadline in milliseconds (100–30000,
default 10000). Each case runs in a fresh child process with a 128 MiB V8 old-space
limit and a 1 MiB captured-output limit. The fixture file is limited to
256 KiB and 64 cases. No failed case is retried.

## Cases, mocks and expectations

```json
{
  "format": 1,
  "cases": [{
    "name": "Transform a message",
    "node": "transform",
    "inputs": {"value": {"message": "hello"}},
    "expect": {"outputs": {"completed": {"message": "hello"}}}
  }]
}
```

Each case selects a resolved local graph node. `parameters` overrides contract
defaults; graph parameter bindings and variables are not automatically resolved
for fixtures. Supply explicit `bindings` and fake `secrets` maps when needed.
Components declaring files, Git or sessions require an absolute
`parameters.worktree`; the command's worktree selects source and does not silently
fill this setting. Scripts receive `inputs`; custom triggers receive `cursor`
(default null); readouts receive an artificial delivery envelope. Host-trigger
adapters run as HuddleNode with raw event data in `inputs.event`; this does not
start their host watcher or timer.

`fetch` is an ordered list of `{url, method?, body?, status?, response}`. Method
defaults to GET and status to 200. URL/method and, when supplied, body must match
exactly. `{reply: JSON_VALUE}` returns a JSON response; `{error: "lost reply"}`
throws. Calls never fall back to real fetch. Every mock must be consumed, and an
unexpected call fails even when component code catches the error. Assertions do
not currently match headers or stream responses.

`operations` supplies ordered `{request, response}` pairs for the existing
puddlang client. For example, a script attaching `fixture-agent` and asking
`Hello` can use:

```json
[
  {
    "request": {"op": "attach", "reference": "fixture-agent"},
    "response": {"reply": {
      "runtime_id": "00000000-0000-4000-8000-000000000001",
      "session_id": "00000000-0000-4000-8000-000000000002"
    }}
  },
  {
    "request": {
      "op": "ask",
      "handle": {
        "runtime_id": "00000000-0000-4000-8000-000000000001",
        "session_id": "00000000-0000-4000-8000-000000000002"
      },
      "request": {"prompt": "Hello"}
    },
    "response": {"reply": "Fixture reply"}
  }
]
```

Requests are compared as JSON exactly. Structured asks include the generated
`output_schema`, and replies remain strings parsed by the real client. These
fake handles do not identify real sessions. The runner does not reproduce host
agent admission, lifecycle transitions or native completion confirmation.

`expect` must contain at least one of:

- `outputs`: script completion ports.
- `result`: readout delivery/observation result, including unknown outcomes.
- `emissions`: script `{port, value}` emissions or full trigger event objects.
- `health` and `checkpoints`: ordered trigger reports and cursor values.
- `errorIncludes`: a required substring of an expected component failure.

Selected expectations use exact deep equality; omitted observations are not
asserted. Trigger emit returns a fake acknowledged sequence, then checkpoint and
health callbacks record values. `observeMs` keeps the subscription open after
opening (0–5000, default 0), and its close method runs afterwards. Readout `mode`
is `deliver` by default or `observe` for a contract supporting observation.
`abortAfterMs` (1–5000) aborts the component signal to exercise cancellation;
the outer process deadline still applies if code ignores it. Observations and
mock lists are limited to 64 entries each.

## What a passing result establishes

The examples cover transform output, feed admission/checkpoint progress,
confirmed report delivery and an unknown result after a lost reply. Add cases
for the behavior of your own integration, including gaps and cancellation.
Run ordinary Validate separately: this command tests selected components, not
the whole graph, its resource bindings or live execution admission.

This command **executes trusted project code**. The child inherits a small
environment allowlist instead of Puddle credentials, and fetch/agent APIs are
test doubles, but this is not an OS sandbox. Node built-ins retain filesystem,
process and network access; code can spawn children outside the runner's deadline.
Use disposable data and fake secrets. No runner result establishes real-provider,
restart, durable cursor or external-service behavior.

Maintainers keep implementation under `daemon/src/huddle/testing/`. Regenerate
the client assets with `node scripts/build-huddle-testing.mjs`; `--check` detects
drift. The portable bundle reuses production wrappers/import loading rather than
implementing a second graph runtime.
