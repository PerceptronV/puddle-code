export const huddleAuthoringGuide = `# Huddle authoring kit

These files describe the bundled CLI's contracts, not proof of a connected host's
capabilities. Inspect the target host and validate saved source there before use.
No kit command writes project files, starts a session, imports project code or
activates a graph. The kit works without a daemon connection.

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
Credentials and managed secret references are not provided by this kit.

examples/manual.json wires Run -> transform -> Result without external services.
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

Use pudl huddle inspect/validate with explicit profile/project/worktree and huddle
id to review saved files. Start/Apply is separate explicit execution intent; use
the reviewed digest and exact inspected owner target. Never refresh targets or
retry a mutation automatically after a failed reply. Two agents may communicate
through explicit bounded feedback; removing feedback edges must leave a DAG.
Keep account/worktree selections and turn/spawn/time budgets explicit.
`;
