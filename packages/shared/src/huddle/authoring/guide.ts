export const huddleAuthoringGuide = `# Huddle authoring kit

These files describe the bundled CLI's contracts, not proof of a connected host's
capabilities. Inspect the target host and validate saved source there before use.
No kit command writes project files, starts a session, imports project code or
activates a graph. The kit works without a daemon connection.

On host 28.27+, pudl huddle create accepts --request '{"template":"manual"}' or
'{"template":"review-loop"}' alongside explicit --name, --project and --worktree.
MCP huddle_create accepts the same optional template field; omission stays blank.
starters/manual/ and starters/review-loop/ contain those complete graphs, layout,
source, README and input fixtures. When copying offline assets, replace the all-zero
id with the new directory id and /replace/with/registered/worktree with a registered
canonical root. Host creation fills that explicit worktree from its selected scope.
Review-loop leaves agent bindings unset: choose both existing sessions before
validation/Start. It uses five rounds/ten turns and sends only approval to Result.
Creation never launches a runtime or selects an account/agent.

On host 28.28+ and runtime calendar: 2, the version-1 built-in
puddle.trigger.calendar-date supplies monthly/yearly events. Bind months to a
JSON array of numbers 1–12 and day to 1–31; all months means monthly, one means
yearly. Missing dates are skipped, including February 29 in non-leap years.
Use explicit timeZone and local HH:mm time. It shares Calendar's missed policy
and bounded catch-up. Daily/weekday Calendar and Date and time still support
calendar: 1; inspect the selected runtime before using the new source.

## Files and examples

schemas/ contains JSON Schema draft 2020-12 for format-1 huddle.json, component
manifests and layout.json, plus the supported port/parameter schema subset.
Keep all four files together. Associate them using your editor's JSON-schema
settings; do not add a $schema property to strict format-1 source documents.
These are structural editor aids. Runtime refinements additionally check paths,
reserved identifiers, byte/depth/entry limits, required properties, cross-field
rules, worktree bindings, graph edges and feedback. pudl huddle validate remains
authoritative for saved-source validation; it does not execute or type-check code.

types/puddlang-huddle.d.ts declares the worker-supplied puddlang/huddle and puddlang
modules. Include it in your TypeScript project's files/include list. Use strict
TypeScript with ES2023 and DOM libraries (AbortSignal, fetch); install zod 4 in the
authoring project's development environment to resolve these declarations. Runtime code
uses the pinned zod helper, not that development installation. No runtime npm
package named puddlang is required. The declarations are generated from actual
wrapper/context/agent types; generation checks prevent drift.

templates/{transform,feed,report}/ are ordinary editable component files. Copy a
chosen directory under .puddle/huddle/<huddle_id>/nodes/<name>/ and reference its
node.json from a local graph node. Their dependencies include http.ts explicitly.
The transform returns its input. Feed assumes a pull API returning gap, cursor and
up to 16 stable-id events with individual cursors. Null cursor means the source's
documented initial page; adapt this policy deliberately. It acknowledges each
event before progressing, reports missing history as a gap, bounds requests to
five seconds/256 KiB and closes its timer and pending I/O. Report expects a
successful JSON {accepted: true, receipt: ...}; other replies remain unknown.
The idempotency header alone does not imply deduplication; the template declares
idempotent false and never automatically retries or observes uncertain delivery.
Adapt both adapters to a real service's documented semantics before activation.
On host 28.23 with integrationSecrets:1, declare string parameters with editor
secret and no default. Settings contain logical references, never credentials.
The operator supplies huddle-integrations.json in private Puddle home with exact
profileId/projectId/huddleId/worktree grants and a values map. Require private
same-user mode 0600 and no symlink/hard links. Access context.secrets?.PARAMETER_NAME;
parameters still hold references. Start/Apply and worker startup check availability.
The private file is bounded to 64 KiB; each grant has at most 16 nonempty values of
4096 characters. References match /^[a-z][a-z0-9_-]{0,63}$/.
Secret-worker logs and failure/health diagnostics are redacted. Never emit secrets
as outputs, receipts, cursors or prompts. Existing workers retain original values;
Interrupt/Resume or Stop/Start is needed to refresh them after rotation/revocation.
The kit includes no actual credentials. Custom code retains trusted OS authority.

templates/{transform,format-text,condition,merge,join}/ match the editable flow
nodes in Add node on application 28.25+. Transform starts as an identity script;
edit run.ts and its contract to map values. Format text uses the agent prompt
{{input}} / {{input.field}} substitution with the same 128 KiB limit. Condition
compares the field selected by a JSON path array (default ["complete"]) with equals
(default true). An empty path compares the whole input. Equality does not coerce
values and ignores object key order; missing fields fail. Exactly one optional
matched/unmatched completion output carries the original input. Merge forwards
each arriving alternative independently with any activation. Join waits for both
left/right inputs from the same execution and activation; it returns {left,right}.
Use shared fan-out for Join and Merge for mutually exclusive branches. Do not wire
separate triggers/event emissions into a Join expecting latest-value behaviour.
These are ordinary scripts and inherit the existing execution/value limits.

templates/file-report/ is the editable Write report readout (host catalogue 28.22+).
It requires an explicit canonical worktree and relative path, creates missing parent
directories and publishes at most 256 KiB without overwriting existing files.
Text preserves string inputs; JSON adds indentation and a newline. Path placeholders
are {{huddleId}}, {{executionId}} and {{invocationId}}. Include Node 22 typings
(@types/node) and enable allowImportingTsExtensions for no-emit TypeScript checks.
Unknown outcomes can be observed through readoutObservation:1: matching bytes prove
the desired state, not writer identity. Observation never writes. Add report output
directories to Filetree outputPaths explicitly; a crash may leave a staging file.

examples/manual.json wires Run -> transform -> Result without external services.
examples/flow.json wires Run -> Condition -> Merge -> Transform/Format text -> Join
-> Result. Copy its five referenced template directories into nodes/ and supply
manual input such as {"complete": true, "message": "Ready"}. Both decision branches
continue once; the joined result contains the original data and formatted text.
examples/feed-report.json wires feed -> transform -> report and requires explicit
feedUrl/reportUrl variables. Replace the example id with the chosen directory's
32-lowercase-hex id. Creation of a new huddle must generate 16 random bytes and
check collisions; do not use these fixture ids for new definitions. Copy templates
to the nodes paths referenced by each graph. Opening/saving a graph does not arm it.
Network templates need customTriggers:1/readouts:1 runtime support (host 28.7+).
File, Git and session components additionally need explicit worktree declarations;
never infer a worktree from process cwd. Custom source has trusted host OS authority.

fixtures/ contains fake source responses and expected transform/delivery outcomes.
Use these in a separate trusted-code test with mocked fetch and acknowledged emit/
checkpoint/health callbacks. No fixture points to a live provider. Runtime tests
must verify contract outputs, cursor progression after admission, gap handling,
unknown delivery and cancellation; static JSON Schema validation cannot do so.

On host 28.26+, pudl huddle duplicate HUDDLE_ID --name NAME --project PROJECT_ID
--worktree ABSOLUTE_WORKTREE --request '{"expected_digest":"REVIEWED_DIGEST"}'
copies a saved definition in that worktree to a fresh random id and stopped
placement. MCP huddle_duplicate takes the same fields. Copies include bounded
UTF-8 source, docs and fixtures but no private runtime state or unsaved drafts.
Only manifest id/name change; review preserved literal resource bindings before
activation. Private variable values and integration grants must be supplied anew.
After a lost reply, list saved huddles before another explicit copy; never retry.

Use pudl huddle inspect/validate with explicit profile/project/worktree and huddle
id to review saved files. Start/Apply is separate explicit execution intent; use
the reviewed digest and exact inspected owner target. Never refresh targets or
retry a mutation automatically after a failed reply. Two agents may communicate
through explicit bounded feedback; removing feedback edges must leave a DAG.
Keep account/worktree selections and turn/spawn/time budgets explicit.

On host 28.20 with nativeFeedback:1, native-prompt-agent/native-review-agent templates
can confirm asks against an existing Turn completed source. Manifest nativeCompletion
names a string parameter whose value is that source node id. agent.askNative() has
the same prompt/structured overloads as ask(), but resolves once only after matching
native and ask evidence. Source and script must select the same existing agent and
worktree. Use its result in ordinary bounded feedback; automated events never start
another root. Stop, source replacement, gaps and takeover end the wait without
resending. Standalone pudl run does not support native confirmation.
`;
