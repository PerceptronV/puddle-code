/** One-shot mobile modifiers use the same sequences as a hardware keyboard. */
export function touchModifiedInput(data: string, modifiers: number): string {
  const ctrl = (modifiers & 1) !== 0;
  const alt = (modifiers & 2) !== 0;
  if (isArrowInput(data)) {
    return modifiers ? `\x1b[1;${1 + (alt ? 2 : 0) + (ctrl ? 4 : 0)}${data.slice(-1)}` : data;
  }
  if (ctrl && data.length === 1) {
    const code = data.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
    else if (data === ' ') data = '\x00';
    else if (data === '?') data = '\x7f';
  }
  return alt ? `\x1b${data}` : data;
}

export function isArrowInput(data: string): boolean {
  return data.length === 3 && data.startsWith('\x1b[') && 'ABCD'.includes(data[2]!);
}
