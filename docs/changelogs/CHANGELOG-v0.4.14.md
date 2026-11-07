<!--
Archived release changelog. Governance lives in CLAUDE.md §"Changelog discipline".
-->

# Changelog

## [0.4.14] — 2026-11-06

### Cockpit

#### Fixed

- Keep short Ripple conversations above a bottom-aligned native input without resizing the terminal. Preserve reader-originating Shift+Arrow keys, use native history shortcuts for Gemini and OpenCode, retain connected terminal diagrams, and exclude Gemini’s scrollbar and OpenCode’s sidebar from reading and shared Mermaid/LaTeX detection.

- Extend Ripple prompt bubbles and native-input detection to Claude Code, Gemini CLI and OpenCode. Respect OpenCode’s painted conversation canvas and sidebar boundary, remove Gemini’s prompt backing edges, and keep following delayed CLI scroll responses.

- Preserve Ripple overlines, underline styles/colours, painted spaces, bright ANSI text, live terminal palette changes and labelled HTTP(S) hyperlinks. Keep concealed text hidden and hyperlink keyboard activation in the reader.

- Render Ripple over a full-size terminal with a draggable, row-anchored native-input boundary. Follow CLI scrolling, relay wheel input, reflow full-width prose, preserve ANSI styling, and show Codex prompts as user bubbles while retaining native controls and shared Markdown/Mermaid/LaTeX rendering.
