# Custom huddle readouts

A readout sends graph inputs to a destination and records whether delivery was
confirmed, refused or uncertain. Project-local readouts require application 28.5
and a runtime advertising `readouts: 1`. They run in captured workers on the project
host, using the same trusted-code model as puddlang scripts.

Create these files beneath `.puddle/huddle/<huddle_id>/nodes/report/`:

```text
node.json
readout.ts
```

`node.json` defines settings, input/output ports and delivery support:

```json
{
  "format": 1,
  "id": "project.readout.report",
  "version": 1,
  "category": "readout",
  "title": "Send report",
  "entry": "./readout.ts",
  "capabilities": ["network"],
  "readout": {
    "idempotent": false,
    "reconciliation": "none",
    "cancellation": "signal"
  },
  "parameters": {
    "endpoint": {
      "title": "Endpoint",
      "schema": { "type": "string" },
      "editor": "text"
    }
  },
  "inputs": { "report": { "schema": {} } },
  "outputs": { "completed": { "schema": {} } }
}
```

This example expects a destination that confirms delivery with a successful JSON
response. Adjust the response handling to the destination's documented semantics:
an HTTP error alone does not always prove that the action was refused.

```ts
import { HuddleReadout } from 'puddlang/huddle';

export default HuddleReadout({
  contract: './node.json',
  async deliver(context, delivery) {
    try {
      const response = await fetch(String(context.parameters.endpoint), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': delivery.idempotencyKey,
        },
        body: JSON.stringify(delivery.inputs.report),
        signal: context.signal,
      });
      if (!response.ok) {
        return { status: 'unknown', message: 'Destination did not confirm delivery' };
      }
      const receipt = await response.json();
      return { status: 'delivered', receipt, outputs: { completed: receipt } };
    } catch {
      return { status: 'unknown', message: 'Destination reply was unavailable' };
    }
  },
});
```

In the IDE, choose **Add local node** with `nodes/report/node.json`, configure
**Endpoint**, and connect an upstream output to `report`. Save, then explicitly
Start or Apply. Opening the graph and inspecting settings never executes the module.
Put additional source files in `dependencies` so activation captures their exact
contents. The readout's contract path is relative to its component directory.

The immutable delivery contains all named inputs from the invocation, its root
event and scope, source port, graph revision, node, invocation id and idempotency
key. Settings and resolved bindings are also immutable. File, Git and session
components must declare an explicit `worktree` parameter; use `context.bindings`
for resolved resource references. A network-only component need not invent a file
or session binding. Integration-secret references are not implemented yet; keep
credentials out of graph source files.

Return one of:

- `{ status: 'delivered', receipt, outputs? }` after confirmation. The receipt and
  outputs must be bounded JSON. Outputs must match the declared completion ports.
- `{ status: 'failed', message }` when the destination confirms that delivery failed.
- `{ status: 'unknown', message }` when the outcome cannot be established.

The owner records delivery intent before evaluating project code. It retains a
confirmed receipt before acknowledging the worker, then waits for successful
worker exit before routing completion outputs. Throwing, timing out or exiting
without a receipt leaves the delivery unknown. The original operation stays
consumed and is not automatically sent again. History exposes the retained
operation outcome even when its graph execution failed.

Only declare `idempotent: true` when the destination actually deduplicates the
supplied key; sending a header alone is insufficient. The declaration does not
enable retries. `cancellation: 'signal'` lets the adapter pass the abort signal to
its I/O and perform brief cleanup; termination cannot prove the action was undone.
Use `'none'` when the adapter cannot cooperate.

Adapters declaring `reconciliation: 'observe'` must also export
`async observe(context, delivery)` returning the same result type. This method must
query the original delivery by its retained key and must not resend it.

With application 28.6 and a runtime advertising `readoutObservation: 1`, open
**History → Operations → Check delivery** on an unknown readout in an ended
execution. This runs `observe` using the original captured script, parameters,
bindings, inputs and idempotency key, even if the graph has since been edited or
Apply selected a newer revision. The owner records delivered/failed/unknown in
the operation history. The ended graph remains ended and publishes no new outputs.
A delivered observation may return its receipt without reconstructing graph outputs;
any supplied outputs still have to satisfy the captured port schemas.

Observation shares the huddle worker pool and has a 30-second deadline. Interrupt
and Stop cancel it. Observe must perform read-only destination lookup; the SDK
rejects agent operations and event emissions in this mode. Captured custom code
remains trusted host code, so this is not an OS sandbox. The destination's lookup
must distinguish a proven refusal from an absent or not-yet-visible receipt;
inconclusive lookup returns `unknown`.

An accepted check can finish after the frontend disconnects. If the reply is lost,
inspect history before another action. Refreshing history never schedules another
check. For a still-unknown outcome, **Refresh delivery** enables another deliberate
check; there is no automatic polling of the destination or delivery retry. Checking
requires the original live owner and retained source; stopped/offline owner recovery
is not yet available.


## Check a delivery after Stop

On application 28.21+, open recorded History for the stopped huddle, select the
execution's Operations and choose **Check delivery** on an eligible unknown readout.
The adapter must have declared observation support. **Refresh delivery** reads the
retained outcome; an accepted check is not yet proof of delivery.

Puddle runs the original captured `observe` method with its original delivery and
idempotency key. The editable source may have changed or been deleted. It does not
restart the huddle, resume the ended graph or call `deliver` again. The action
requires a confirmed clean owner shutdown and an available worktree; recover an
interrupted owner first. Unarchive the huddle/project before requesting a check.

CLI/MCP use `observe-retained-readout SESSION_ID --request JSON` /
`huddle_observe_retained_readout` with `{owner: {runtimeId, incarnation}, operation_id}`.
Read `history-owners` and `retained-history` to select the exact recorded owner and
operation. Retained history accepts `include_readout_observation: true` to request
eligible offers. After a failed or lost reply, inspect retained history before any
new explicit action; reconnect never repeats a check automatically.

## Write report

On application 28.22+, choose **Add node → Write report**. Select the worktree,
connect a value to its input and configure a path relative to that worktree.
The default is `reports/{{huddleId}}/{{invocationId}}.md`; paths also support
`{{executionId}}`. Text preserves a string input exactly. JSON formats any input
with indentation and a trailing newline. Reports are limited to 256 KiB.

The node creates missing parent directories and publishes a complete file without
replacing an existing destination. An existing file fails delivery and is preserved,
even if its contents match. Choose a new path for a new delivery. The completed
output contains worktree, relative path, SHA-256 and byte count. Inspect/edit the
ordinary `node.json`, `run.ts` and `file.ts` files to customize the component.

The runtime records intent through its normal readout operation. A lost reply or
interruption after publication can leave an unknown outcome. **Check delivery**
compares the intended contents without creating or changing files. Matching bytes
confirm the desired state, not which process wrote them; missing or edited files
remain unknown. Checking delivery never resumes an ended graph or retries a write.
It also works after clean Stop through the retained-observation path above.

Paths cannot traverse outside the worktree, pass through symlink parents, or include
Git/Puddle metadata directories. These checks are not a sandbox for trusted custom
scripts or a guarantee against hostile filesystem mutation. Atomic publication
requires a filesystem supporting hard links; failure is reported without falling
back to an overwrite. A process crash may leave a `.puddle-report-*` staging file.
Add the report directory to every relevant Filetree trigger's **Output paths**
exclusions, including staging files, to prevent output-triggered feedback.
