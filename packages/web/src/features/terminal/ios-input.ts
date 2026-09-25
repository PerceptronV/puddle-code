import type { Terminal } from '@xterm/xterm';

const IOS =
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const WIDTH = 8;
// Three blank rows with the caret mid-row, so the caret can always step in every direction.
const PAD = Array<string>(3).fill(' '.repeat(WIDTH)).join('\n');
const CENTRE = WIDTH + 1 + WIDTH / 2;

/**
 * iOS turns a held spacebar into a trackpad that moves the textarea caret. Keep xterm's
 * hidden textarea filled with blank padding and send one arrow key per caret step, then
 * recentre. The padding never holds typed text: keys still go through xterm, while
 * keyless insertions (predictions, dictation) and IME commits are forwarded here so they
 * cannot edit the padding. Taps are left to xterm, so mouse-aware applications receive
 * them. Other platforms keep xterm's input unchanged.
 */
export function attachIosTerminalInput(terminal: Terminal, active: () => boolean): () => void {
  if (!IOS) return () => {};
  const textarea = terminal.textarea!;
  // xterm registers its listeners on the textarea itself; capturing on its parent runs first.
  const host = textarea.parentElement!;
  const abort = new AbortController();
  const options = { capture: true, signal: abort.signal };
  let composing = false;
  // xterm's `nowrap` collapses the padding's newlines into a single row.
  textarea.style.whiteSpace = 'pre';
  const send = (data: string | null) => {
    if (data && active()) terminal.input(data, true);
  };
  const recentre = () => {
    if (textarea.value !== PAD) textarea.value = PAD;
    textarea.setSelectionRange(CENTRE, CENTRE);
  };
  const moved = () => {
    if (composing || document.activeElement !== textarea) return;
    const { selectionStart: start, selectionEnd: end } = textarea;
    if (textarea.value === PAD && start === CENTRE && end === CENTRE) return;
    if (textarea.value === PAD) {
      const caret = start === CENTRE ? end : start;
      const row = Math.floor(caret / (WIDTH + 1)) - 1;
      const column = (caret % (WIDTH + 1)) - WIDTH / 2;
      const key = row < 0 ? 'A' : row > 0 ? 'B' : column < 0 ? 'D' : 'C';
      send(`\x1b${terminal.modes.applicationCursorKeysMode ? 'O' : '['}${key}`);
    }
    // Also restores the padding after xterm clears the textarea (Enter, Ctrl-C).
    recentre();
  };
  host.addEventListener('focus', recentre, options);
  host.addEventListener(
    'keydown',
    (event) => {
      // xterm would diff the textarea against the padding and send the difference.
      if (composing || event.isComposing) event.stopImmediatePropagation();
    },
    options,
  );
  host.addEventListener(
    'beforeinput',
    (event) => {
      if (composing || event.isComposing) return;
      // Typed keys arrive here only when xterm did not handle their key event.
      event.preventDefault();
      send(
        {
          insertText: event.data,
          insertLineBreak: '\r',
          insertParagraph: '\r',
          deleteContentBackward: '\x7f',
          deleteWordBackward: '\x1b\x7f',
          deleteContentForward: '\x1b[3~',
        }[event.inputType] ?? null,
      );
    },
    options,
  );
  host.addEventListener(
    'compositionstart',
    (event) => {
      event.stopImmediatePropagation();
      composing = true;
    },
    options,
  );
  host.addEventListener('compositionupdate', (event) => event.stopImmediatePropagation(), options);
  host.addEventListener(
    'compositionend',
    (event) => {
      event.stopImmediatePropagation();
      composing = false;
      send(event.data);
      recentre();
    },
    options,
  );
  document.addEventListener('selectionchange', moved, { signal: abort.signal });
  if (document.activeElement === textarea) recentre();
  return () => abort.abort();
}
