<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- Previews typeset **LaTeX** with KaTeX — `$…$` / `\(…\)` inline, `$$…$$` / `\[…\]` / ` ```math ` display — in both the markdown and the HTML view. KaTeX over MathJax: it is synchronous and needs no live document, so a preview re-renders on every keystroke and the sandboxed HTML iframe's maths is typeset before the document is serialised into it (its fonts travel baked into the document, since a null origin cannot load a font from ours). `$…$` follows pandoc's rules, so prose currency stays prose.
- README: hero screenshot of the desktop cockpit — a live Claude Code session split beside the rendered README (light + dark under `docs/assets/`).
