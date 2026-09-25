export interface NativeText {
  text: string;
  cursor: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const textSegments = (text: string) => Array.from(segmenter.segment(text));

/** DOM offsets are UTF-16; terminal cursor keys and backspace move whole characters. */
export function cursorKeys(text: string, from: number, to: number, application = false): string {
  const count = textSegments(text.slice(Math.min(from, to), Math.max(from, to))).length;
  return `\x1b${application ? 'O' : '['}${to < from ? 'D' : 'C'}`.repeat(count);
}

/** A native replacement (suggestion, dictation, selection edit) becomes one bounded edit. */
export function nativeTextEdit(previous: NativeText, next: NativeText, application = false) {
  if (previous.text === next.text)
    return {
      prefix: cursorKeys(previous.text, previous.cursor, next.cursor, application),
      inserted: '',
      suffix: '',
    };
  const before = textSegments(previous.text);
  const after = textSegments(next.text);
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix]!.segment === after[prefix]!.segment
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix]!.segment === after[after.length - 1 - suffix]!.segment
  )
    suffix++;
  const start = before[prefix]?.index ?? previous.text.length;
  const oldEnd = before[before.length - suffix]?.index ?? previous.text.length;
  const newEnd = after[after.length - suffix]?.index ?? next.text.length;
  return {
    prefix:
      cursorKeys(previous.text, previous.cursor, oldEnd, application) +
      '\x7f'.repeat(before.length - prefix - suffix),
    inserted: next.text.slice(start, newEnd),
    suffix: cursorKeys(next.text, newEnd, next.cursor, application),
  };
}
