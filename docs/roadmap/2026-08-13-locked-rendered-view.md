# Locked rendered-view scroll following

**Status:** Implemented — protocol 16.0 and the browser-local scroll adapters
landed on 2026-08-13.

**Recorded:** 2026-08-13

## Outcome

Add a fourth viewing mode for renderable file tabs: **locked**. A locked tab is
a linked rendered preview that also follows the vertical document position of
the current active renderable tab. It is a read-only receiving surface: moving
through the active source or ordinary preview moves every locked preview of the
same target, while scrolling a locked preview does not move anything else.

The resulting mode cycle is:

```text
source → preview → linked → locked → source
```

`preview` is the existing persisted/code name for the user's “view” mode. Do
not rename it while adding `locked`; a rename would add migration work without
changing the behaviour.

## Behaviour contract

- Locked has all existing linked semantics: it is a stable follow slot whose
  `(session, path[, root])` retargets to the most recently active renderable
  `file` or `external` tab in the current layout scope.
- A locked slot additionally mirrors the active tab's **normalised vertical
  progress**. Version one does not promise line-, heading-, or AST-level
  alignment: Monaco source, rendered Markdown, and arbitrary HTML reflow
  differently, so exact semantic correspondence is not generally available.
- The active eligible tab is the driver. An eligible driver is a focused active
  `file` or `external` tab with a renderable type, in `source` or `preview`
  mode. `linked` and `locked` tabs never drive other followers.
- Locked is one-way. User scrolling in the locked surface is allowed but is
  overwritten by the next driver update; it never feeds back into the source
  or another locked pane.
- If no eligible driver is active, the locked slot keeps its last target and
  position. When a new eligible driver becomes active, retarget first and
  apply only a position recorded for that target; never apply the previous
  file's position to a newly followed file.
- Any number of locked slots in the layout scope follow together. A pane may
  contain one `linked` slot and one `locked` slot because their stable slot
  identities are distinct.
- Scope matches existing linked behaviour: project-local when
  `projectBasedLayout` is enabled, profile-wide when it is disabled.
- The mode persists in the layout snapshot. Scroll position does not persist
  across reloads in version one; it is transient browser state and begins
  following as soon as an eligible driver publishes.
- Only Markdown and HTML participate initially, matching the current rendered
  preview pipeline. Media, diff, commit, terminal, and untitled tabs do not.

## Protocol decision

Adding `locked` to `editorTabRefSchema.view` requires **protocol 16.0**, with
the minor reset to zero. This is a major bump even though it adds an enum value:
`view` is a closed enum nested in the daemon-validated `ui_state` snapshot. A
15.x daemon would reject a state PUT containing `locked` rather than safely
ignore it, causing every later workspace save to fail. This is the same reason
`linked` introduced protocol 15.0.

The scroll synchronisation itself needs no daemon API, WebSocket message, or
stored field. Do not add one. The client and daemon upgrade together through
the existing major-version handshake.

When implementation begins:

1. Add `locked` to the shared schema and bump `PROTOCOL_VERSION` to 16.0 in the
   same commit.
2. Record the bump in `packages/shared/src/protocol.ts`, `SPEC.md` §6, and
   `CHANGELOG.md`.
3. Add handshake/schema tests proving a 15.x daemon cannot be treated as
   compatible with snapshots containing `locked`.

Do not bump the protocol for this roadmap document.

## Design

### 1. Tab identity and retargeting

Extend `EditorView` to `'source' | 'preview' | 'linked' | 'locked'`. Keep two
distinct stable slot keys, for example `linked` and `locked`; neither key may
include the current target identity. This preserves React instances and layout
focus when a follower retargets, while allowing a leaf to contain one of each.

Generalise the linked-only layout helpers instead of duplicating them:

- `isFollowing(ref)` recognises `linked` and `locked`;
- `linkableTarget(ref)` rejects both follower modes so followers never chase
  followers;
- `retargetFollowingTabs(tree, target)` rewrites every follower's target while
  preserving whether each slot is `linked` or `locked`;
- `setTabView` remaps `activeKey` and `previewKey` when entering or leaving
  either stable slot key, and dissolves into an existing owner on collision as
  linked mode does today.

Retargeting must remain absent from `layoutSignature`: which file a follower
currently shows is runtime focus state, not structural layout drift. Entering
or leaving a viewing mode remains a real layout change.

Update the tab toggle to show a lock glyph in the fourth state and revise its
tooltip. Preserve the current hover-overlay sizing and filename marquee.

### 2. Transient scroll store

Add a small external store in the editor feature, rather than putting scroll
position into React layout state. The store should hold the most recent
normalised position per target identity:

```ts
type PreviewScrollTarget = {
  session: string;
  path: string;
  root?: string;
};

type PreviewScrollPosition = {
  ratio: number; // clamped to 0..1
  revision: number;
};
```

Include the layout scope/channel in the store key so independent project trees
and browser windows do not affect one another. Target identity must include
`root`; otherwise an external file and a worktree file with the same relative
path would cross-talk.

Publish at most once per animation frame. Calculate:

```text
ratio = scrollTop / max(1, scrollHeight - viewportHeight)
```

Subscribers apply `ratio * maxScroll` immediately. Store the last value so a
locked surface mounted after the driver can catch up. A target switch subscribes
to the new target before applying anything; an absent value means “wait for a
driver”, not “reuse the previous ratio”.

Thread only the minimum context through `PaneLeaf` → lazy editor body →
`PaneEditorBody`: whether this mounted body is the eligible driver, whether it
is a locked receiver, and its layout-local scroll channel. Do not infer driver
status from DOM focus inside the preview component; tab-strip activation and
pane-body focus already define it at the layout level.

### 3. Monaco adapter

For an eligible source editor:

- subscribe to `editor.onDidScrollChange`;
- read `getScrollTop()`, `getScrollHeight()`, and the editor viewport height;
- publish the normalised ratio on scroll, initial mount/focus, model change,
  and layout change;
- rate-limit publishing with `requestAnimationFrame`.

If Monaco is ever used as a locked receiver, apply with
`setScrollTop(..., ScrollType.Immediate)` and suppress publication from that
receiver. Version one only renders locked Markdown/HTML, but keeping the maths
adapter independent makes it testable and reusable.

### 4. Markdown adapter

Put the ref on Markdown's existing `h-full overflow-y-auto` outer scroller,
not the inner prose body.

- An eligible ordinary preview publishes its ratio from a passive scroll
  listener and once on mount/focus.
- A locked preview subscribes and sets the outer element's `scrollTop`.
- Reapply the latest ratio after content changes and height changes. Use a
  `ResizeObserver` because image loading, font metrics, maths rendering, and
  viewport resizing can all change the maximum scroll after the first apply.

### 5. Sandboxed HTML adapter

The HTML iframe deliberately omits `allow-same-origin`; the parent cannot read
or set its scroll position directly, and that security boundary must remain.
Inject a minimal scroll bridge into the generated `srcDoc`:

- report a normalised ratio to the parent with `postMessage`, at most once per
  animation frame;
- accept an apply message carrying a ratio;
- report again after load and internal `ResizeObserver` height changes;
- identify every mount with an unguessable/local channel id.

The parent accepts a message only when `event.source === iframe.contentWindow`,
the message kind and channel match, and the ratio is a finite number. Do not
trust `event.origin`: the sandbox origin is intentionally `null`. The bridge
must never receive the daemon token or relax the iframe sandbox. Arbitrary page
scripts can at worst alter this local scroll channel; they gain no authenticated
capability.

### 6. Lifecycle and feedback prevention

- Drivers publish; locked surfaces consume. Never attach both roles to one
  mount.
- Dispose Monaco listeners, DOM listeners, `ResizeObserver`s, message
  listeners, store subscriptions, and pending animation frames on unmount or
  target/channel change.
- Guard async HTML document generation and iframe load messages by mount id so
  a stale target cannot move the new target.
- Reapply after layout/content height changes without republishing from a
  locked receiver. This prevents oscillation and multi-pane feedback loops.

## Expected implementation seams

Shared and protocol:

- `packages/shared/src/api/ui-state.ts`
- `packages/shared/src/protocol.ts`
- shared schema and CLI handshake tests

Tab/layout behaviour:

- `packages/web/src/features/editor/editor-tabs.ts`
- `packages/web/src/features/workspace/PaneTabStrip.tsx`
- `packages/web/src/features/workspace/layout-tree.ts`
- `packages/web/src/features/workspace/useLayoutTree.ts`
- `packages/web/src/features/workspace/PaneLeaf.tsx`
- `packages/web/src/features/editor/lazy-editor-parts.tsx`
- `packages/web/src/features/editor/PaneEditorBody.tsx`

Scroll plumbing:

- new `packages/web/src/features/editor/preview-scroll-store.ts`
- `packages/web/src/features/editor/CodeEditor.tsx`
- `packages/web/src/features/editor/FilePreview.tsx`
- optionally a focused `html-preview-scroll.ts` module if the iframe bridge
  would push `FilePreview.tsx` further past the repository's module-size seam

Documentation on landing:

- `SPEC.md` §6 for protocol history and §8 for the fourth viewing mode
- `CHANGELOG.md`
- the relevant Phase 3 manual acceptance script
- `AGENTS.md` only if the implementation changes its repo map or conventions

## Verification

### Automated tests

- Shared schema accepts and round-trips `locked`; protocol is exactly 16.0.
- A locked tab has a stable key distinct from both `linked` and an ordinary
  file tab.
- Entering/leaving locked mode remaps leaf pointers and handles key collisions.
- Linked and locked slots retarget together while preserving their own modes;
  neither can become a driver.
- Retargeting does not dirty a saved layout signature.
- Scroll maths clamps empty, short, over-scrolled, and resized documents.
- Store subscriptions are scoped by layout and target, replay the latest value,
  ignore old-target updates, and dispose cleanly.
- Markdown reports and applies scroll without a receiver feedback loop.
- HTML bridge messages are rejected for a wrong window, channel, kind, or
  non-finite ratio and accepted only for the current iframe.
- Rooted external previews never share position with a same-path worktree file.

### Manual checks

- Put Markdown source beside one and then multiple locked previews; scroll,
  type, undo/redo, resize panes, and switch targets.
- Use an ordinary rendered Markdown preview as the driver.
- Repeat with long HTML, including an HTML page whose script also uses
  `postMessage` and content that changes height after load.
- Exercise source-to-Markdown, source-to-HTML, and rendered-to-rendered
  following; confirm the documented proportional, not semantic, alignment.
- Verify project-based and profile-wide layout scopes, both light and dark
  themes, browser reload, and multiple browser windows.
- Repeatedly open/close/retarget panes and confirm there are no retained Monaco
  models, event listeners, observers, or iframe channels.

Run the full repository gates:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Never launch `puddled` from the agent session.

## Explicitly out of scope

- Bidirectional or leader-election scroll synchronisation.
- Exact source-line, Markdown-heading, DOM-node, or source-map alignment.
- Persisting scroll position in `ui_state` or on the daemon.
- A daemon endpoint or WebSocket message for scroll events.
- Editing or action controls in a locked preview.
- Locked media, diff, commit, terminal, or untitled tabs.
- Coupling this mode to dirty-diff gutter peeks or source-control hunk actions.

## Suggested delivery order

1. Protocol 16.0, shared/web mode types, stable keys, layout retargeting, and
   their pure tests.
2. Mode-toggle UI and locked rendered body, without scroll following yet.
3. Scroll store plus Monaco and Markdown adapters.
4. Sandboxed HTML bridge and security tests.
5. SPEC/changelog/acceptance updates, full automated gates, and manual
   multi-pane leak verification.

Keep each step independently reviewed and committed. Do not declare the mode
complete until HTML reliably follows after delayed content reflow; otherwise
the user-visible fourth state would be present but intermittently inert.
