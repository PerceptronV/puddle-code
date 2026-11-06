import type { IBufferCell, ITheme } from '@xterm/xterm';

export interface RippleStyle {
  start: number;
  end: number;
  css: string;
}
const paletteKeys = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

function colour(value: number, palette: boolean, theme: ITheme): string | undefined {
  if (palette) {
    if (value < 16) {
      const result = theme[paletteKeys[value]!];
      return result && /^#[\da-f]{6}$/i.test(result) ? result : undefined;
    }
    if (value < 232) {
      const levels = [0, 95, 135, 175, 215, 255];
      const n = value - 16;
      value =
        (levels[Math.floor(n / 36)]! << 16) |
        (levels[Math.floor(n / 6) % 6]! << 8) |
        levels[n % 6]!;
    } else {
      const grey = 8 + (value - 232) * 10;
      value = (grey << 16) | (grey << 8) | grey;
    }
  }
  return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Only generated, validated CSS reaches the reader; terminal text never supplies CSS. */
export function rippleCellStyle(cell: IBufferCell | undefined, theme: ITheme): string {
  if (!cell || cell.isInvisible?.()) return '';
  const css: string[] = [];
  if (cell.isBold?.()) css.push('font-weight:700');
  if (cell.isItalic?.()) css.push('font-style:italic');
  const decoration = [
    cell.isUnderline?.() ? 'underline' : '',
    cell.isStrikethrough?.() ? 'line-through' : '',
  ].filter(Boolean);
  if (decoration.length) css.push(`text-decoration:${decoration.join(' ')}`);
  if (cell.isDim?.()) css.push('opacity:0.65');
  let fg =
    cell.isFgDefault?.() === false || cell.isFgPalette?.() || cell.isFgRGB?.()
      ? colour(cell.getFgColor(), !!cell.isFgPalette(), theme)
      : undefined;
  let bg =
    cell.isBgDefault?.() === false || cell.isBgPalette?.() || cell.isBgRGB?.()
      ? colour(cell.getBgColor(), !!cell.isBgPalette(), theme)
      : undefined;
  if (cell.isInverse?.()) [fg, bg] = [bg ?? theme.background, fg ?? theme.foreground];
  if (fg && /^#[\da-f]{6}$/i.test(fg)) css.push(`color:${fg}`);
  if (bg && /^#[\da-f]{6}$/i.test(bg)) css.push(`background-color:${bg}`);
  return css.join(';');
}

/** Markers survive escaped HTML and code fences without permitting terminal-supplied HTML. */
export function markRippleStyles(text: string, styles: RippleStyle[], codex = false) {
  let prefix = '\uE000ripple';
  while (text.includes(prefix)) prefix += '_';
  const replacements = new Map<string, string>();
  let offset = 0;
  const marked = text
    .split('\n')
    .map((line) => {
      const prompt = codex && /^\s*[›❯]\s/.test(line);
      const start = offset;
      offset += line.length + 1;
      if (/^\s*(`{3,}|~{3,})/.test(line)) return line;
      // Leave Markdown block markers and the Codex prompt marker at the line start.
      const structural = /^(\s*(?:(?:[•●›❯*-]|\d+[.)])\s+)?(?:#{1,6}\s+|>\s+)?)/.exec(line)![0]
        .length;
      for (const range of styles.toReversed()) {
        let from = Math.max(structural, range.start - start);
        let to = Math.min(line.length, range.end - start);
        if (to <= from) continue;
        const content = line.slice(from, to);
        from += content.length - content.trimStart().length;
        to -= content.length - content.trimEnd().length;
        if (to <= from) continue;
        const open = `${prefix}${replacements.size}\uE001`;
        // A sticky Codex prompt's inverse backing is CLI chrome. Its bubble
        // supplies the backing instead; keep semantic emphasis and other colours.
        const css =
          prompt && range.css.includes('background-color:')
            ? range.css
                .split(';')
                .filter((declaration) => !/^(?:background-color|color):/.test(declaration))
                .join(';')
            : range.css;
        replacements.set(open, `<span style="${css}">`);
        const close = `${prefix}${replacements.size}\uE001`;
        replacements.set(close, '</span>');
        line = line.slice(0, from) + open + line.slice(from, to) + close + line.slice(to);
      }
      return line;
    })
    .join('\n');
  return {
    text: marked,
    restore: (html: string) => {
      for (const [marker, tag] of replacements) html = html.replaceAll(marker, tag);
      return html;
    },
  };
}
