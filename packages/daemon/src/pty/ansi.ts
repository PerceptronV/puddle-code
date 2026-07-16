// OSC sequences (ESC ] … BEL/ST), then CSI (ESC [ … final byte) and other
// two-byte escapes (ESC + single char).
// eslint-disable-next-line no-control-regex
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
// eslint-disable-next-line no-control-regex
const CSI_AND_OTHERS = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/g;

/**
 * Strip ANSI escape sequences. Status patterns are matched against clean
 * text — agent TUIs colour their prompts, and regexes written against clean
 * text silently never match raw PTY bytes (SPEC §5).
 */
export function stripAnsi(input: string): string {
  return input.replace(OSC, '').replace(CSI_AND_OTHERS, '');
}

// OSC 0/1/2 set the icon name / title: ESC ] {0|1|2} ; <title> (BEL | ESC \).
// eslint-disable-next-line no-control-regex
const OSC_TITLE = /\u001b\][012];([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;

// Leading spinner/status glyphs a TUI prefixes to its title (Claude Code
// animates a Braille spinner: `⠐ hey`). Stripping them keeps the stored name
// stable across animation frames. `\p{S}` covers the Braille block and symbols
// like ✳; the run is only stripped from the START, so real titles are intact.
const LEADING_GLYPHS = /^[\s\p{S}]+/u;

/**
 * The terminal title a process last set in `data` via an OSC 0/1/2 escape,
 * normalised to a single ≤80-char line with any leading spinner/status glyphs
 * removed — or null if the chunk set no (non-empty) title. This is the VSCode
 * `${sequence}` name (SPEC §4). Only fully-terminated sequences are read, so a
 * title split across PTY chunks is picked up once complete rather than partway.
 */
export function extractOscTitle(data: string): string | null {
  let last: string | null = null;
  OSC_TITLE.lastIndex = 0;
  for (let m = OSC_TITLE.exec(data); m !== null; m = OSC_TITLE.exec(data)) last = m[1] ?? '';
  if (last === null) return null;
  const cleaned = last.replace(LEADING_GLYPHS, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return cleaned === '' ? null : cleaned;
}
