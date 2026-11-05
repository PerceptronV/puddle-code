# UI quality review

Reviewed 2026-11-05; source references checked against `60fc193`.

## Assessment

The desktop workspace now has a recognisable design language: floating islands,
empty gutters, rounded action trays, persistent gold selections, and motion that
preserves the identity of controls. The remaining work is mainly bringing older
surfaces and shared primitives into that language and documenting its rules.

Colour discipline in the React application is already strong. The source scan did
not reveal widespread stock Tailwind colours or component-local hex palettes.
The clearest independent palette is in the native desktop connection prompts.
Using semantic colours alone, however, does not guarantee consistent styling or
adequate contrast for every new combination.

This is a targeted source audit, not an exhaustive visual or accessibility audit.
It covers shared components and CSS, desktop prompts, workspace controls, settings,
mobile/remote controls, and representative older popovers. Recommendations below
are not implemented fixes. Source references use repository-relative paths and
review-time line numbers. Priorities express cleanup value, not incident severity.

## Proposed additions to HUMANS.md

Keep HUMANS.md a concise human design brief. Put component APIs and exact numerical
geometry in the implementation rather than turning the brief into a CSS manual.
Retain its existing rule about genuinely empty optional fields.

The current wording combines “borders only to delineate islands” with “ideal if no
borders shown at all.” Clarify that island outlines are intentional, while ordinary
control feedback comes from fills. Document the deliberate exception for resize
feedback. Also clarify “transparency and opaqueness”: gaps are transparent; floating
controls need sufficiently opaque surfaces to remain legible over scrolling content.

Suggested wording for the design framework:

> **Islands and space.** Organise the interface into calm, rounded floating islands.
> Leave real, empty space between them. Use outlines to distinguish islands, not to
> box every control. Give overlapping controls and overlays enough backing to remain
> legible; reserve pronounced shadows for floating overlays. Align text, icons, and
> insets, with room to breathe at each supported density.
>
> **Simple controls.** Show only the information and actions needed in the current
> context. Related actions share a tray; a single action stays compact. Plain sidebar
> open/collapse buttons remain plain. Hover actions float above content without
> shrinking labels, moving neighbouring content, or covering a full-height strip.
> Avoid duplicate state indicators when the action tray already communicates them.
>
> **Responsive interaction.** Interactive elements respond immediately through
> appropriate cursors and restrained fill changes. Provide equally clear keyboard
> focus and touch access; essential actions must not depend on hover. Keep ordinary
> borders stable. For resizing, emphasise the facing island edges in their existing
> border colour, following their rounded corners; leave the gutter empty.
>
> **Selection and colour.** Use gold for persistent navigation selection, distinct
> from hover and temporary pressed states. Hover stays beneath selection and content.
> Primary text and controls use the same visual language as the editor; reserve muted
> text for secondary information. Preserve explicitly chosen project and profile
> colours in their respective contexts. Application colours come from the shared
> semantic palette, with readable foreground/background pairs in every theme.
>
> **Motion explains continuity.** Controls move from their current position to their
> counterpart when layouts change. Persistent selection and hover indicators slide
> from their previous position. Resize live editor content with its layout; avoid
> duplicate snapshots of editor controls. Elements without counterparts fade in
> place. Dialogues and popovers appear with a gentle fade and slight growth, and
> toggles slide. Interruptions and rapid interactions should continue smoothly from
> the current visible state.
>
> **Motion is optional.** Respect both the system preference and “Reduced animation
> and motion.” Suppress decorative transitions, animations, and their unnecessary
> rendering work when reduced motion is enabled. Keep immediate feedback and all
> functionality. Avoid idle decorative animation and do not equate reduced motion
> with a promise of zero GPU use.
>
> **One system, appropriate adaptations.** Reuse shared surface, tray, field, menu,
> and motion components. Adapt geometry for touch and native shells without inventing
> another palette or interaction language. Content such as code, terminal output,
> documents, and recognised file/brand artwork can retain meaningful specialist
> presentation.

Record the following concrete decisions alongside the implementation, so later
cleanup does not undo the iteration:

- Resize emphasis is 3px, in the normal island border colour, tapering into corners.
- Multi-action trays use circular item hover fills; single-action controls should
  not acquire a padded outer tray plus a conflicting inner shape.
- Session controls float over scrolling content, but the initial project heading
  starts below them. Search retains the current project/archive visibility scope.
- Header command-palette text is muted by default; an explicit project colour
  applies to the relevant project text and shortcut. Profile colours remain separate.
- Settings have separate navigation and content islands. The navigation island owns
  its title and close button; its persistent selection is gold.
- Reduced motion sits directly below Density without explanatory body text.

Update SPEC §12's introductory “no boxes/borders” shorthand when adopting this brief.
It already defers to HUMANS.md, but the shorthand does not describe the intentional
island outlines. Palette tables should remain subordinate to `tokens.css`.

## Findings

### 1. Native desktop prompts have a separate palette and control system

**Priority: high consistency value.**

`packages/desktop/src/connect-prompt.html:16`, `host-picker.html:16`, and
`ssh-auth-prompt.html:15` define their own light/dark colours. The connection and SSH
prompts use blue primary actions (`#2f6feb` / `#4c82f0`), independent neutral and
danger colours, and literal white action text. Fields and buttons have local 6px
radii. These are user-facing parts of the product, but do not inherit the cockpit's
palette or geometry.

**Recommendation:** Generate or package a small shared semantic stylesheet for
these standalone pages, including surface/control geometry. Preserve their ability
to run before a daemon connection; sharing styling does not require mounting the
React application. Apply the saved theme when available, otherwise the system theme.

**Acceptance:** Compare connection, host picker, and SSH authentication windows in
both themes with the cockpit, including errors, disabled actions, and focus states.

### 2. Gold selected text exposes a gap in the contrast guard

**Priority: high.**

`packages/web/src/components/ui/control-tray.css:64` uses `--text-gold` as the
selected background and `--bg-base` as its foreground. In the light theme this is
white on `#8a7663`: **4.328:1**, below the 4.5:1 target for ordinary small text.
The settings navigation now uses this combination for text labels, not just glyphs.

`packages/web/scripts/check-tokens.mjs:65` checks only base, surface, and elevated
backgrounds, omitting the tray background. Its coloured-fill checks cover only
`--action-ink` on `--action`; gold has a 3:1 floor when checked as a foreground.
Consequently the existing checker passes while missing this selected-label pairing.

**Recommendation:** Give persistent selection an explicit background/foreground
pair, or adjust the existing combination centrally. Test actual text/fill pairings,
including selection, action hover, danger actions, and tray surfaces. Treat custom
project/profile colours as a separate legibility policy rather than silently
discarding those user choices.

**Verification:** The existing token checker passed both themes and its 42 pairs
per theme. The selected-label ratio above was calculated using the repository's
`scripts/contrast.mjs` helper. Passing that checker is not a full accessibility claim.

### 3. Menus and selects do not share the new overlay treatment

**Priority: medium.**

Dialogs and popovers use the shared overlay motion and surface radius. In contrast,
`components/ui/select.tsx`, `dropdown-menu.tsx`, and `context-menu.tsx` still render
their content with `rounded-md bg-elevated p-1 shadow-xl`, without the new overlay
motion class or island surface recipe. Submenus repeat that treatment.
`tooltip.tsx` has another closely related local recipe.

This affects Appearance selects, file/session context menus, and dropdown menus
throughout the app: opening a settings dialogue and opening a menu inside it follow
different visual rules.

**Recommendation:** Share an overlay surface/motion recipe with intentional variants
for menus, larger panels, and compact tooltips. Preserve Radix positioning, transform
origins, focus handling, and close timing. Do not animate every overlay to an identical
size or force a large island radius onto tiny tooltips.

**Acceptance:** Check nested menus, edge-of-window placement, keyboard opening,
interrupted closing, and reduced motion as well as the normal pointer interaction.

### 4. Shared field and button geometry still diverges from the new tokens

**Priority: medium.**

`components/ui/button.tsx:7` uses `rounded-md`, `font-medium`, and fixed Tailwind
height variants. `components/ui/recipes.ts:13` uses `rounded-md` for fields and
`rounded-sm` for menu rows; `select.tsx` uses an `h-8` trigger. New trays instead use
`--ui-control-height` and `--ui-surface-radius`, with feature-specific overrides for
settings navigation and header text.

These components are shared, but they still represent different generations of
the design. “Uses Button” therefore does not by itself establish consistency.

**Recommendation:** Define the intended field, compact icon, text-action, and menu
row geometry through shared semantic sizes/radii. Keep deliberate size variants;
do not make every control the same height. Review density and user font-size scaling
before replacing fixed utilities globally.

### 5. Floating tab actions still depend on pointer hover for keyboard access

**Priority: high.**

`features/workspace/panes/PaneTabStrip.tsx:234` makes the floating action container
visible on `focus-within`, but several child controls at lines 286, 324, 357, and
486 remain `hidden` until `group-hover`. `features/editor/tabs/EditorTabClose.tsx:98`
uses the same pattern. A `display: none` child cannot receive keyboard focus and
trigger its parent's focus styling. The coarse-pointer override helps touch, not
ordinary keyboard navigation.

**Recommendation:** Reveal relevant actions when their tab contains focus, or keep
the actions focusable with deliberate visibility and pointer-event handling.
Preserve accessible labels and keyboard close commands. Apply the same policy to
preview/run/archive actions, not only the close cross.

**Acceptance:** Navigate tabs and every available action using only the keyboard;
check visible focus, no title reflow, touch access, and single-action tray geometry.

### 6. Internal resize boundaries do not use the facing-edge feedback

**Priority: medium.**

`features/changes/ChangesNav.tsx:100` and
`features/workspace/sessions/SessionSidebar.tsx:1227` use `HeightHandle` with
transparent normal and hover backgrounds. The shared implementation in
`components/resizable-height.tsx:114` otherwise uses a line that changes to an accent
fill. Neither treatment reproduces `features/workspace/layout/IslandSeparator.tsx`
and its rounded facing-edge emphasis.

**Recommendation:** Share the feedback mechanism for vertically stacked islands
as well as side-by-side panes. Keep each feature's sizing behaviour and minimums,
while highlighting the relevant island edges and leaving the gap empty.

**Acceptance:** Check Changes/History and the session archive boundary at rest,
hover, and drag, including rounded ends and compact density.

### 7. Mobile controls retain a parallel styling implementation

**Priority: medium; adapt deliberately.**

`features/mobile/PhoneSessionRail.tsx` builds its controls and session rows using
local buttons and `phone-*` classes rather than the shared tray behaviour.
`features/remote/remote.css:419` already adds island surfaces, but retains separate
control, selection, and expanded-rail rules. This is partial adoption, not a wholly
unthemed interface.

`features/mobile/LocalPhonePane.tsx:26` uses a native select and a locally styled
review switch; `features/mobile/Composer.tsx:101` defines its own textarea surface.
These are additional places where desktop primitive changes do not propagate.

**Recommendation:** Share semantic surface and control recipes and evaluate which
tray behaviours transfer to touch. Preserve large touch targets, mobile keyboard
behaviour, and the benefits of native selection where appropriate. Do not copy
desktop hover-dependent controls into the phone UI.

**Acceptance:** Cover local and remote phone workspaces, expanded/collapsed rail,
selection, archive, composer focus, and reduced motion on an actual touch viewport.

### 8. Older popovers still use local action and colour recipes

**Priority: medium/low.**

`features/scratchpad/ScratchpadPopover.tsx:163` and
`features/layouts/LayoutsPopover.tsx:271` use hand-styled gold add buttons and local
rounded hover fills. Their confirmation actions also repeat local text/button
recipes; scratchpad deletion at line 326 and layout confirmation around line 605
use the session-status colour `text-interrupted` for destructive actions.

These are semantic-token uses, not raw colour violations, but status and destructive
intent are different roles. Their independently styled controls can drift from the
new shared action groups.

**Recommendation:** Use a shared compact action treatment and the danger semantic
role for destructive confirmation. Review filters as persistent selections where
appropriate. Do not convert ordinary content chips or every inline text action
into another nested island.

### 9. Toast appearance is only partially integrated

**Priority: low.**

`components/ui/sonner.tsx:16` uses semantic foreground/background colours but a local
`0 8px 30px rgb(0 0 0 / 0.25)` shadow, leaving other geometry to Sonner defaults.
This is a small shadow inconsistency, not evidence of a second React palette.

**Recommendation:** Give toast surfaces an explicit shared overlay recipe, retaining
their readable diagnostic text and dismissal behaviour. Review both themes and
reduced motion before deciding whether a shared shadow token is warranted.

### 10. Persistent tray identity needs a stronger contract

**Priority: follow-up validation.**

`components/ui/use-tray-selection.ts:3` caches marker rectangles in a module-level
map keyed by accessible label and orientation. It stores target coordinates, rather
than an in-flight rendered rectangle. Two instances with the same label/orientation
can share cached geometry; remounting mid-transition can restart from the previous
destination rather than the currently visible position.

This is a source-level risk, not a reproduced claim that every current tray jumps.

**Recommendation:** Give persistent trays explicit stable identities, scope cached
state to the intended layout lifetime, and preserve the visible marker position
when an interrupted transition crosses a remount. Retain the existing hover,
selection, and content stacking order.

**Acceptance:** Rapidly switch selection, collapse/reopen sidebars mid-animation,
resize trays, and mount two same-labelled instances. Verify gold follows its actual
counterpart and never expands/fades as an unrelated surface. Repeat with reduced
motion enabled.

## Guardrails and intentional exceptions

The token checker validates `tokens.css`; it does not enforce source-wide use of
semantic colours or styled components. Add a narrowly scoped raw-colour guard for
application chrome, with explicit exceptions for token definitions, recognised
artwork, fixtures, and generated/vendor content. Do not ban raw `<button>` elements:
shared trays and specialised interactions legitimately compose them. Prefer shared
recipes and targeted review over a rule that forces every element through one API.

Do not count these as styling defects without additional evidence:

- Material file icons and recognised brand artwork retaining their original colours.
- Code syntax, terminal ANSI output, diffs, document/PDF content, or notebook output
  having specialist presentation. Their surrounding chrome should still be consistent.
- User-selected project/profile colours that differ from the default palette.
- Larger mobile controls, native macOS traffic lights, or compact plain sidebar
  toggles. These are deliberate adaptations or explicit design decisions.
- Data updates and terminal rendering that continue under reduced motion. Functional
  rendering is distinct from optional decorative animation.

## Suggested implementation order

1. Adopt the HUMANS.md clarification and add the missing selected-text contrast
   pairing. Fix keyboard access to floating tab actions.
2. Consolidate shared overlay, field, action, and resize-feedback recipes. Validate
   them in the sample preview before broad migration.
3. Bring native prompts, older popovers, and mobile surfaces into the shared language,
   one surface family at a time.
4. Exercise interrupted tray/sidebar motion and establish stable tray identities.
   Add regression coverage around demonstrated failures rather than every CSS rule.

Use light/dark themes, both densities, increased UI font size, keyboard-only input,
touch, custom project/profile colours, and reduced motion as the review matrix.
Include rapid hover/selection, overlay opening/closing, and sidebar reversal cases.
Visual checks should verify stable editor controls, empty gutters, unclipped titles,
and coherent rounded insets, not just that the destination layout is correct.
