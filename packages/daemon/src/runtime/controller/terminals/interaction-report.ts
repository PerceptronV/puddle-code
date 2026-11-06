// xterm emits focus reports and default/SGR mouse reports as whole messages.
// SGR cell and pixel coordinates share the same wire shape.
const INTERACTION_REPORT =
  // eslint-disable-next-line no-control-regex -- terminal report encodings
  /^(?:\x1b\[[IO]|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\x20-\xff]{3})$/;

/** Recognise one report, never a report mixed with typed or pasted input. */
export function isTerminalInteractionReport(data: string): boolean {
  // Compare the whole match because `$` also permits a trailing newline.
  return INTERACTION_REPORT.exec(data)?.[0] === data;
}
