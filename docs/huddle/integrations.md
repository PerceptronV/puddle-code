# Private huddle integration secrets

Application 28.23 and runtime `integrationSecrets: 1` support private integration
references for script, trigger and readout components. Existing agent accounts keep
their normal authentication; this feature never reads or exports account login
secrets, application tokens or host-control credentials.

On the machine running the huddle, create `huddle-integrations.json` directly in
that installation's Puddle home (normally `~/.puddle`). Keep it owned by the daemon's
OS user, with mode `0600`, as a regular file with no symlink or extra hard links.
Do not put it under a project worktree. Use the exact profile/project ids, huddle
id and canonical worktree root from the huddle placement:

```json
{
  "format": 1,
  "grants": [
    {
      "profileId": "YOUR_PROFILE_ID",
      "projectId": "YOUR_PROJECT_ID",
      "huddleId": "0123456789abcdef0123456789abcdef",
      "worktree": "/absolute/canonical/project/worktree",
      "values": { "report_service": "REPLACE_WITH_PRIVATE_SERVICE_TOKEN" }
    }
  ]
}
```

One exact scope must match one grant. Another project, profile, huddle or worktree
cannot use that grant through this resolver. Multiple matching grants are an error.
The file is bounded to 64 KiB and 64 grants, each with at most 16 references. Each
value is a nonempty string of at most 4096 characters; the resolved values sent to
one worker must also fit 64 KiB. Host configuration is managed directly on the host;
there is no browser endpoint for reading or writing secret values.

Declare a component parameter in `node.json`:

```json
"parameters": {
  "token": {
    "title": "Report service reference",
    "editor": "secret",
    "schema": { "type": "string" }
  }
}
```

In the IDE set that parameter to `report_service`, or bind it to a `secret` variable
containing that reference. References use 1–64 lowercase letters, digits, `_` or
`-`, beginning with a letter. Secret parameters require a string schema and cannot
have defaults. The source and captured settings contain the reference only. Never
paste a credential into a node setting, graph variable, prompt or source file.

In the adapter, access the value by **parameter name**, not reference name:

```ts
const token = context.secrets?.token;
if (!token) throw new Error('Report service is unavailable');
const response = await fetch(String(context.parameters.url), {
  headers: { Authorization: `Bearer ${token}` },
  signal: context.signal,
});
```

`context.parameters.token` remains `report_service`; `context.secrets.token` holds
the private value. The secrets map is frozen. Do not put secrets in outputs, event
data, cursors, receipts, agent prompts or files: those are application data and may
be retained. Trusted project code still has the OS user's authority; these grants
and diagnostic protections are not a sandbox against deliberate extraction.

Start/Apply checks availability before activation and repeats the check at final
admission. Missing references, wrong scope, malformed/changed files and insecure
permissions produce a generic unavailable error without private paths or contents.
Workers independently reread the exact grant immediately before startup, including
readout observation after a clean Stop. No secret values are copied into activated
revisions, bindings, runtime journals, launch environments or command arguments.
They travel only in the private worker startup frame and remain in process memory.

Replace the private file atomically, preserving ownership and mode, to rotate or
remove values. New workers use the latest configuration. Existing subscriptions
and running scripts retain their original values: Interrupt/Resume or Stop/Start
refreshes them; editing the file alone cannot recall a value already delivered.
Interrupted external actions remain subject to the usual unknown-outcome rules.
Observation uses current credentials for the original logical reference, so keep
its destination and account meaning stable when rotating values.

For every component declaring secret parameters, stdout/stderr are replaced with
redaction markers. Worker failures, readout failure/unknown messages and trigger
health diagnostics are redacted before owner callbacks record them. This avoids
partial-chunk credential leakage, but deliberately reduces diagnostic detail.
Ordinary typed outputs, receipts and cursors are not automatically rewritten.
