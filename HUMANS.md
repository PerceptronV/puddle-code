# HUMANS.md

This document is written by a human to guide the overall stylistic choices of agents in development.

## Puddle design framework

This section details the _feel_ of the puddle UI.

Overall, emphasise the following elements in your frontend design:

- Emphasise transparency and opaqueness.
- Emphases components as floating islands.
- Obsessive minimalism.
- Aligned texts and large spacing.
- Use borders only to delineate islands.
- Always be responsive: cursors should change upon hover over componenets.
- Responsiveness should never employ borders: e.g. make buttons or entry boxes dim or change colour upon hover and clicking, but their borders should not change. In fact, ideal if no borders shown at all.

In more detail:

**Islands and space.** Organise the interface into calm, rounded floating islands.
Leave real, empty space between them. Use outlines to distinguish islands, not to
box every control. Give overlapping controls and overlays enough backing to remain
legible; reserve pronounced shadows for floating overlays. Align text, icons, and
insets, with room to breathe at each supported density.

**Simple controls.** Show only the information and actions needed in the current
context. Related actions share a tray; a single action stays compact. Plain sidebar
open/collapse buttons remain plain. Hover actions float above content without
shrinking labels, moving neighbouring content, or covering a full-height strip.
Avoid duplicate state indicators when the action tray already communicates them.

**Responsive interaction.** Interactive elements respond immediately through
appropriate cursors and restrained fill changes. Provide equally clear keyboard
focus and touch access; essential actions must not depend on hover. Keep ordinary
borders stable. For resizing, emphasise the facing island edges in their existing
border colour, following their rounded corners; leave the gutter empty.

**Selection and colour.** Persistent navigation selection follows the chosen host
accent, distinct from hover and temporary pressed states; use gold when no accent
is chosen. A chosen host accent carries through the whole interface's text,
controls, surfaces and borders, not just selected items. Keep semantic status,
syntax/ANSI, document/artwork and explicit project/profile colours independent.
Hover stays beneath selection and content.
Primary text and controls use the same visual language as the editor; reserve muted
text for secondary information. Preserve explicitly chosen project and profile
colours in their respective contexts. Application colours come from the shared
semantic palette, with readable foreground/background pairs in every theme.

**Motion explains continuity.** Controls move from their current position to their
counterpart when layouts change. Persistent selection and hover indicators slide
from their previous position. Resize live editor content with its layout; avoid
duplicate snapshots of editor controls. Elements without counterparts fade in
place. Dialogues and popovers appear with a gentle fade and slight growth, and
toggles slide. Interruptions and rapid interactions should continue smoothly from
the current visible state.

**Motion is optional.** Respect both the system preference and “Reduced animation
and motion.” Suppress decorative transitions, animations, and their unnecessary
rendering work when reduced motion is enabled. Keep immediate feedback and all
functionality. Avoid idle decorative animation and do not equate reduced motion
with a promise of zero GPU use.

**One system, appropriate adaptations.** Reuse shared surface, tray, field, menu,
and motion components. Adapt geometry for touch and native shells without inventing
another palette or interaction language. Content such as code, terminal output,
documents, and recognised file/brand artwork can retain meaningful specialist
presentation.

## Practical design choices

- Empty fields should be truly empty. Agents have a habit of leaving optional fields empty and filling them with default values after user submits form. This is very counter-intuitive. If empty fields will be re-interpreted as something else, just fill in that field with the something else. Note: placeholders and descs for such fields should continue to remain meaningful.
