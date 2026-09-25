/* eslint-disable no-control-regex -- Match terminal control sequences, not prose. */
import type { Terminal } from '@xterm/xterm';
import { cursorKeys, nativeTextEdit, textSegments, type NativeText } from './native-edit';
import { tappedInputOffset } from './native-input-cells';
import { nativeComposition } from './native-composition';

const MAX_CONTEXT = 8_192;

/**
 * Keep native keyboard context on touch devices. xterm 6.0.0 only forwards appended
 * insertText; suggestions replace text and iOS's spacebar changes DOM selection.
 * Capture those events before xterm, leaving desktop input and control keys to it.
 * The mirror is ephemeral, never reconstructed from (possibly secret) PTY output.
 */
export function attachNativeTerminalInput(terminal: Terminal, active: () => boolean) {
  const textarea = terminal.textarea!;
  // xterm registers capture listeners on the textarea itself; its parent runs first.
  const inputHost = textarea.parentElement!;
  const composition = nativeComposition(terminal);
  const abort = new AbortController();
  const options = { capture: true, signal: abort.signal };
  let value: NativeText = { text: '', cursor: 0 };
  let composing = false;
  let cancelledComposition = false;
  let sending = false;
  const coarse = matchMedia('(pointer: coarse)');
  const enabled = () => coarse.matches;
  const usable = () => enabled() && active();
  const reset = () => {
    if (composing) cancelledComposition = true;
    value = { text: '', cursor: 0 };
    textarea.value = '';
    composing = false;
    composition.clear();
  };
  const emit = (data: string, paste = false) => {
    if (!data || !active()) return;
    sending = true;
    try {
      if (paste) terminal.paste(data);
      else terminal.input(data, true);
    } finally {
      sending = false;
    }
  };
  const configure = () => {
    textarea.setAttribute('autocorrect', enabled() ? 'on' : 'off');
    textarea.setAttribute('autocapitalize', enabled() ? 'sentences' : 'off');
    textarea.spellcheck = enabled();
  };
  const synchronise = () => {
    if (!usable()) {
      reset();
      return;
    }
    const next = { text: textarea.value, cursor: textarea.selectionEnd };
    const edit = nativeTextEdit(value, next, terminal.modes.applicationCursorKeysMode);
    value = next;
    emit(edit.prefix);
    const paste = /[\r\n\x1b]/.test(edit.inserted);
    emit(edit.inserted, paste);
    emit(edit.suffix);
    if (paste || value.text.length > MAX_CONTEXT) reset();
  };
  const select = () => {
    // Selection changes caused by input are reconciled by that input event. Moving
    // only the caret (including the iOS spacebar trackpad) sends cursor keys once.
    if (
      !usable() ||
      composing ||
      document.activeElement !== textarea ||
      textarea.value !== value.text
    )
      return;
    const cursor = textarea.selectionEnd;
    if (cursor === value.cursor) return;
    const keys = cursorKeys(
      value.text,
      value.cursor,
      cursor,
      terminal.modes.applicationCursorKeysMode,
    );
    value = { ...value, cursor };
    emit(keys);
  };
  const observe = (data: string) => {
    if (sending || !enabled()) return;
    if (/^\x1b(?:\[|O)[CD]$/.test(data) && value.text) {
      const positions = [...textSegments(value.text).map((part) => part.index), value.text.length];
      const index = positions.indexOf(value.cursor);
      const cursor = positions[index + (data.endsWith('D') ? -1 : 1)];
      if (cursor === undefined) {
        reset();
        return;
      }
      value.cursor = cursor;
      textarea.setSelectionRange(value.cursor, value.cursor);
    } else if (!/^\x1b(?:\[<|\[\?|\[\d+;\d+R|\[I|\[O)/.test(data)) {
      // Enter, history, completion, paste, modified keys and external commands may
      // replace the application's input. Forget context instead of guessing it.
      reset();
    }
  };
  inputHost.addEventListener('focus', configure, options);
  inputHost.addEventListener('blur', reset, options);
  inputHost.addEventListener(
    'keydown',
    (event) => {
      if (!enabled()) return;
      if (!active()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        reset();
        return;
      }
      if (!composing && !event.isComposing) cancelledComposition = false;
      if (composing || event.isComposing || event.keyCode === 229) {
        event.stopImmediatePropagation();
        return;
      }
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      cancelledComposition = false;
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopImmediatePropagation();
        reset();
        emit('\r');
      } else if (
        event.key.length === 1 ||
        event.key === 'Backspace' ||
        event.key === 'Delete' ||
        event.key === 'Unidentified'
      ) {
        event.stopImmediatePropagation(); // let the browser edit the textarea
      }
    },
    options,
  );
  inputHost.addEventListener(
    'keypress',
    (event) => {
      if (enabled()) event.stopImmediatePropagation();
    },
    options,
  );
  inputHost.addEventListener(
    'beforeinput',
    (event) => {
      if (!enabled()) return;
      event.stopImmediatePropagation();
      if (!active()) {
        event.preventDefault();
        reset();
        return;
      }
      if (event.isComposing || composing) return;
      if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
        event.preventDefault();
        reset();
        emit('\r');
      } else if (
        textarea.selectionStart === textarea.selectionEnd &&
        ((event.inputType === 'deleteContentBackward' && textarea.selectionStart === 0) ||
          (event.inputType === 'deleteContentForward' &&
            textarea.selectionEnd === value.text.length))
      ) {
        event.preventDefault();
        reset();
        emit(event.inputType.endsWith('Forward') ? '\x1b[3~' : '\x7f');
      }
    },
    options,
  );
  inputHost.addEventListener(
    'input',
    (event) => {
      if (!enabled()) return;
      event.stopImmediatePropagation();
      if (cancelledComposition) {
        reset();
        return;
      }
      if (!composing && !(event as InputEvent).isComposing) synchronise();
    },
    options,
  );
  inputHost.addEventListener(
    'compositionstart',
    (event) => {
      if (!enabled()) return;
      event.stopImmediatePropagation();
      cancelledComposition = false;
      composing = true;
    },
    options,
  );
  inputHost.addEventListener(
    'compositionupdate',
    (event) => {
      if (!enabled()) return;
      event.stopImmediatePropagation();
      if (composing && active()) composition.update(event.data);
    },
    options,
  );
  inputHost.addEventListener(
    'compositionend',
    (event) => {
      if (!enabled()) return;
      event.stopImmediatePropagation();
      if (cancelledComposition) {
        reset();
        return;
      }
      composing = false;
      composition.clear();
      // Some keyboards commit via a following input event; others update value first.
      // Reconciliation is idempotent, so either ordering sends the final text once.
      synchronise();
    },
    options,
  );
  document.addEventListener('selectionchange', select, { signal: abort.signal });
  configure();
  return {
    observe,
    reset,
    tap(x: number, y: number) {
      if (!active()) return;
      if (usable() && !composing) {
        const offset = tappedInputOffset(terminal, value, x, y);
        if (offset !== null) {
          textarea.setSelectionRange(offset, offset);
          select();
        }
      }
      terminal.focus();
    },
    dispose() {
      abort.abort();
      reset();
      composition.dispose();
    },
  };
}
