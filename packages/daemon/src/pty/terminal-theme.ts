/**
 * Daemon-side answers to the terminal dynamic-colour queries (OSC 10
 * foreground, OSC 11 background — protocol 14.1). An auto-theming agent
 * (Claude Code's theme: auto) queries the terminal background AT SPAWN to
 * pick light or dark — which is usually before any browser viewer has
 * attached to the PTY, so the viewer-side answer the web terminal used to
 * give arrived for nobody and the agent fell back to dark whatever the app's
 * theme. The daemon sees every output byte from the moment the process
 * starts, so it is the one party positioned to answer; clients report their
 * resolved colours over the WS (`theme`, on connect and on theme switches)
 * and the LAST report wins — a deliberate simplification for what is in
 * practice one person's cockpit, matching the stdin rule ("accepted from
 * any viewer, last-writer-wins").
 *
 * The web terminal stops answering these queries against a >=14.1 daemon
 * (Terminal.tsx feature-gates), so an agent never receives two replies.
 */

export type DynamicColourCode = 10 | 11;

/** `#RRGGBB` → the `rgb:RRRR/GGGG/BBBB` X11 form an OSC report carries. */
export function hexToXtermRgb(hex: string): string | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return null;
  const rgb = match[1]!.toLowerCase();
  const pair = (i: number) => rgb.slice(i, i + 2).repeat(2);
  return `rgb:${pair(0)}/${pair(2)}/${pair(4)}`;
}

/**
 * A colour QUERY as it appears in PTY output: `ESC ] 10 ; ? BEL` or the
 * ST-terminated form. A set request (a colour instead of `?`) is not a query
 * and is left alone. The longest match is 8 bytes, which bounds the carry a
 * chunk-boundary scanner needs.
 */
// eslint-disable-next-line no-control-regex -- escape sequences are the subject
const QUERY_RE = /\x1b\](1[01]);\?(?:\x07|\x1b\\)/g;
export const QUERY_CARRY = 8;

/**
 * The OSC 10/11 codes queried in `data`, `tail` being the previous chunk's
 * carry. Only matches that END past the carry count: a query completed by the
 * previous chunk sits wholly inside the carry and was answered then — without
 * the guard, a query landing exactly on a chunk boundary was answered twice.
 */
export function findColourQueries(tail: string, data: string): DynamicColourCode[] {
  const haystack = tail + data;
  const out: DynamicColourCode[] = [];
  for (const match of haystack.matchAll(QUERY_RE)) {
    if (match.index + match[0].length <= tail.length) continue;
    out.push(Number(match[1]) as DynamicColourCode);
  }
  return out;
}

/** The last-reported terminal colours, and the reply an OSC query gets. */
export class TerminalTheme {
  private fg: string | null = null;
  private bg: string | null = null;

  set(fg: string, bg: string): void {
    this.fg = fg;
    this.bg = bg;
  }

  /** The full OSC report for a query, or null when no client has reported yet. */
  report(code: DynamicColourCode): string | null {
    const hex = code === 10 ? this.fg : this.bg;
    if (hex === null) return null;
    const rgb = hexToXtermRgb(hex);
    return rgb ? `\x1b]${code};${rgb}\x1b\\` : null;
  }
}
