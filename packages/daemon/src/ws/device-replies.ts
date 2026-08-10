/**
 * Terminal device-query REPLIES, as they appear in a viewer's stdin (SPEC §6
 * multi-viewer semantics). A program that queries its terminal — `ESC[6n`
 * cursor position, `ESC[c` device attributes, a DECRQSS setting probe —
 * expects one answer, but every attached puddle viewer is a full terminal
 * emulator (web xterm, or the user's own terminal under `puddle attach`) and
 * each answers independently. The program reads one reply; the others land in
 * whatever reads stdin next as junk "typed" input (`^[[37;143R` on the
 * shell's line).
 *
 * The gateway therefore keeps ONE answering viewer per (stream, term) — the
 * most recent attacher/resizer, whose grid is the one the PTY is sized to,
 * so its cursor report is the authoritative one — and strips reply-shaped
 * sequences from every OTHER viewer's stdin. With a single viewer nothing is
 * ever stripped. Typed input is untouched by construction: keyboards emit
 * `ESC[A` / `ESC[1;5C`-style sequences, never `R`/`n` finals with numeric
 * params or `?`/`>` prefixes — with ONE exception, modified F3 (`ESC[1;2R`
 * shift+F3 …), which is indistinguishable from a cursor report at row 1 and
 * is deliberately let through (a swallowed keystroke is worse than a junk
 * sequence this rare).
 *
 * The shapes are exactly what xterm 6 auto-emits (verified 2026-08-10
 * against @xterm/xterm 6.0.0; a real terminal under `puddle attach` answers
 * the same queries the same way):
 *
 *   ESC [ r ; c R          cursor position report        (DSR 6)
 *   ESC [ ? r ; c … R      extended cursor position      (DECXCPR)
 *   ESC [ 0 n / ESC [ 3 n  operating-status report       (DSR 5)
 *   ESC [ ? … c            primary device attributes     (DA1)
 *   ESC [ > … c            secondary device attributes   (DA2)
 *   ESC P 0|1 $ r … ESC \  DECRQSS setting report (vim probes SGR this way)
 *
 * A reply is written atomically by the answering emulator and arrives whole
 * in one stdin message, so matching is per-message with no cross-chunk carry.
 */

// Modified F3: CSI 1 ; <modifier> R with xterm modifiers 2–16 — the one
// keyboard sequence sharing a shape with a device reply (see above).
// eslint-disable-next-line no-control-regex -- escape sequences are the subject
const MODIFIED_F3 = /^\x1b\[1;(?:[2-9]|1[0-6])R$/;

const DEVICE_REPLY =
  // eslint-disable-next-line no-control-regex -- escape sequences are the subject
  /\x1b\[\?\d+(?:;\d+)+R|\x1b\[\d+;\d+R|\x1b\[[03]n|\x1b\[[?>][\d;]*c|\x1bP[01]\$r[^\x1b]*\x1b\\/g;

/**
 * `data` with device-query replies removed — what a non-answering viewer's
 * stdin contributes. Everything that is not a reply shape passes through
 * byte-exact.
 */
export function stripDeviceReplies(data: string): string {
  return data.replace(DEVICE_REPLY, (match) => (MODIFIED_F3.test(match) ? match : ''));
}
