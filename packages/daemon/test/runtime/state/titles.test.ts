import { expect, it } from 'vitest';
import { RuntimeTitles } from '../../../src/runtime/state/titles.js';

it('captures de-animated titles split at every byte boundary, including the terminator', () => {
  for (const code of [0, 1, 2]) {
    for (const end of ['\u0007', '\u001b\\']) {
      const sequence = `\u001b]${code};⠋ a   useful title${end}`;
      for (let i = 1; i < sequence.length; i++) {
        const titles = new RuntimeTitles();
        expect(titles.read(`ordinary text${sequence.slice(0, i)}`)).toBeNull();
        expect(titles.read(sequence.slice(i) + 'ordinary text')).toBe('a useful title');
        expect(titles.read(`\u001b]${code};⠙ a useful title${end}`)).toBeNull();
      }
    }
  }
});

it('bounds partial titles, ignores empty/non-title OSCs and resets deduplication at a native switch', () => {
  const titles = new RuntimeTitles();
  expect(titles.read('\u001b]0;first\u0007\u001b]2;second\u0007')).toBe('second');
  expect(titles.read('\u001b]0;\u0007\u001b]52;ignored\u0007')).toBeNull();
  expect(titles.read('\u001b]0;' + 'x'.repeat(4096))).toBeNull();
  expect(titles.read('tail\u0007')).toBeNull();
  expect(titles.read('\u001b]0;half a')).toBeNull();
  titles.reset();
  expect(titles.read(' title\u0007')).toBeNull();
  expect(titles.read('\u001b]0;second\u0007')).toBe('second');
  expect(titles.read('\u001b]0;' + 'x'.repeat(200) + '\u0007')).toBe('x'.repeat(80));
});
