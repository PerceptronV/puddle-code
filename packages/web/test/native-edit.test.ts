import { expect, it } from 'vitest';
import { cursorKeys, nativeTextEdit } from '../src/features/terminal/native-edit';

it('replaces an autocorrected word without repeating the unchanged suffix', () => {
  expect(nativeTextEdit({ text: 'teh cat', cursor: 3 }, { text: 'the cat', cursor: 3 })).toEqual({
    prefix: '\x7f\x7f',
    inserted: 'he',
    suffix: '',
  });
});

it('replaces selected text and restores a caret in the middle of the prompt', () => {
  expect(
    nativeTextEdit({ text: 'one old three', cursor: 4 }, { text: 'one new three', cursor: 7 }),
  ).toEqual({
    prefix: '\x1b[C'.repeat(3) + '\x7f'.repeat(3),
    inserted: 'new',
    suffix: '',
  });
});

it('keeps graphemes intact for corrections and native cursor movement', () => {
  expect(cursorKeys('a🌊e\u0301b', 5, 1)).toBe('\x1b[D'.repeat(2));
  expect(nativeTextEdit({ text: 'a🌊b', cursor: 3 }, { text: 'a日b', cursor: 2 })).toEqual({
    prefix: '\x7f',
    inserted: '日',
    suffix: '',
  });
  expect(cursorKeys('hello', 5, 2, true)).toBe('\x1bOD'.repeat(3));
});

it('does not resend a composition commit followed by an identical input event', () => {
  expect(
    nativeTextEdit({ text: '日本語 test', cursor: 3 }, { text: '日本語 test', cursor: 3 }),
  ).toEqual({ prefix: '', inserted: '', suffix: '' });
});

it('moves a native caret without rewriting text', () => {
  expect(nativeTextEdit({ text: 'hello', cursor: 5 }, { text: 'hello', cursor: 2 })).toEqual({
    prefix: '\x1b[D'.repeat(3),
    inserted: '',
    suffix: '',
  });
});
