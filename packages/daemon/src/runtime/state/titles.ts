import { extractOscTitle } from '../../pty/ansi.js';

// eslint-disable-next-line no-control-regex
const PARTIAL_TITLE = /^\u001b\](?:[012](?:;[^\u0007\u001b]*(?:\u001b)?)?)?$/;

/** Main-terminal titles only; partial sequences must never cross a native switch. */
export class RuntimeTitles {
  private carry = '';
  private last: string | null = null;

  read(data: string): string | null {
    const text = this.carry + data;
    const title = extractOscTitle(text);
    const start = text.lastIndexOf('\u001b]');
    const tail = start < 0 ? '' : text.slice(start);
    // Retain only an unfinished title introducer/payload (including half an ST).
    this.carry =
      tail.length <= 4096 && PARTIAL_TITLE.test(tail)
        ? tail
        : text.endsWith('\u001b')
          ? '\u001b'
          : '';
    if (title === null || title === this.last) return null;
    this.last = title;
    return title;
  }

  reset(): void {
    this.carry = '';
    this.last = null;
  }
}
