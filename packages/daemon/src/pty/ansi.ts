// OSC sequences (ESC ] … BEL/ST), then CSI (ESC [ … final byte) and other
// two-byte escapes (ESC + single char).
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const CSI_AND_OTHERS = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/g;

/**
 * Strip ANSI escape sequences. Status patterns are matched against clean
 * text — agent TUIs colour their prompts, and regexes written against clean
 * text silently never match raw PTY bytes (SPEC §5).
 */
export function stripAnsi(input: string): string {
  return input.replace(OSC, '').replace(CSI_AND_OTHERS, '');
}
