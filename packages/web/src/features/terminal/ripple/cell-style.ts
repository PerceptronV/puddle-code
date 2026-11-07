import type { IBufferCell, ITheme } from '@xterm/xterm';
import type { ExtendedCell, RipplePalette } from './xterm-style';

export interface RippleStyle {
  start: number;
  end: number;
  css: string;
  href?: string;
  action?: number;
  actionRole?: 'link';
  actionKind?: 'url' | 'file';
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

function colour(
  value: number,
  palette: boolean,
  theme: ITheme,
  ansi?: string[],
): string | undefined {
  if (palette) {
    if (ansi?.[value]) return ansi[value];
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
export function rippleCellStyle(
  cell: IBufferCell | undefined,
  theme: ITheme,
  palette?: RipplePalette,
): string {
  if (!cell || cell.isInvisible?.()) return '';
  const css: string[] = [];
  if (cell.isBold?.()) css.push('font-weight:700');
  if (cell.isItalic?.()) css.push('font-style:italic');
  const decoration = [
    cell.isUnderline?.() ? 'underline' : '',
    cell.isStrikethrough?.() ? 'line-through' : '',
    cell.isOverline?.() ? 'overline' : '',
  ].filter(Boolean);
  if (decoration.length) css.push(`text-decoration:${decoration.join(' ')}`);
  const extended = cell as ExtendedCell;
  if (cell.isUnderline?.()) {
    const style = ['solid', 'solid', 'double', 'wavy', 'dotted', 'dashed'][
      extended.getUnderlineStyle?.() ?? 1
    ];
    if (style) css.push(`text-decoration-style:${style}`);
    if (extended.isUnderlineColorPalette?.() || extended.isUnderlineColorRGB?.()) {
      let value = extended.getUnderlineColor!();
      if (
        palette?.boldBright &&
        cell.isBold?.() &&
        extended.isUnderlineColorPalette?.() &&
        value < 8
      )
        value += 8;
      const underline = colour(value, !!extended.isUnderlineColorPalette?.(), theme, palette?.ansi);
      if (underline) css.push(`text-decoration-color:${underline}`);
    }
  }
  if (cell.isDim?.()) css.push('opacity:0.5');
  let foreground = cell.getFgColor?.();
  if (palette?.boldBright && cell.isBold?.() && cell.isFgPalette?.() && foreground < 8)
    foreground += 8;
  let fg =
    cell.isFgDefault?.() === false || cell.isFgPalette?.() || cell.isFgRGB?.()
      ? colour(foreground, !!cell.isFgPalette(), theme, palette?.ansi)
      : undefined;
  let bg =
    cell.isBgDefault?.() === false || cell.isBgPalette?.() || cell.isBgRGB?.()
      ? colour(cell.getBgColor(), !!cell.isBgPalette(), theme, palette?.ansi)
      : undefined;
  if (cell.isInverse?.()) [fg, bg] = [bg ?? theme.background, fg ?? theme.foreground];
  // Painting the same colour as the reader's canvas is not a highlighted run.
  if (bg?.toLowerCase() === theme.background?.toLowerCase()) bg = undefined;
  if (fg && /^#[\da-f]{6}$/i.test(fg)) css.push(`color:${fg}`);
  if (bg && /^#[\da-f]{6}$/i.test(bg)) css.push(`background-color:${bg}`);
  if (bg || decoration.length) css.push('white-space:break-spaces');
  return css.join(';');
}

/** Markers survive escaped HTML and code fences without permitting terminal-supplied HTML. */
export function markRippleStyles(
  text: string,
  styles: RippleStyle[],
  promptPrefixes: number[] = [],
  anchorText = false,
) {
  if (anchorText) {
    const covered: RippleStyle[] = [];
    let at = 0;
    for (const style of styles) {
      if (style.start > at) covered.push({ start: at, end: style.start, css: '' });
      covered.push(style);
      at = style.end;
    }
    if (at < text.length) covered.push({ start: at, end: text.length, css: '' });
    styles = covered;
  }
  let prefix = '\uE000ripple';
  while (text.includes(prefix)) prefix += '_';
  const replacements = new Map<string, string>();
  const sourceLines = text.split('\n');
  const tableRows = new Set<number>();
  const divider = (line: string) =>
    line.includes('|') && /^[\s|:-]+$/.test(line) && line.includes('-');
  sourceLines.forEach((line, index) => {
    if (!divider(line) || !sourceLines[index - 1]?.includes('|')) return;
    tableRows.add(index - 1);
    for (let row = index + 1; row < sourceLines.length && sourceLines[row]!.includes('|'); row++)
      tableRows.add(row);
  });
  let offset = 0;
  const marked = sourceLines
    .map((line, index) => {
      const promptPrefix = promptPrefixes[index] ?? 0;
      const prompt = promptPrefix > 0;
      const start = offset;
      offset += line.length + 1;
      if (/^\s*(`{3,}|~{3,})/.test(line) || divider(line)) return line;
      // Leave Markdown block markers and the Codex prompt marker at the line start.
      const structural = line.trim()
        ? /^(\s*(?:(?:[•●⏺✦›❯*-]|\d+[.)])\s+)?(?:#{1,6}\s+|>\s+)?)/.exec(
            line.slice(promptPrefix),
          )![0].length + promptPrefix
        : 0;
      // Keep Markdown's table pipes structural; anchor only the cell contents.
      const pieces: Array<{ start: number; end: number }> = [];
      if (tableRows.has(index)) {
        let from = 0;
        for (let col = 0; col < line.length; col++) {
          if (line[col] !== '|' || line[col - 1] === '\\') continue;
          pieces.push({ start: start + from, end: start + col });
          from = col + 1;
        }
        pieces.push({ start: start + from, end: start + line.length });
      }
      const ranges = pieces.length
        ? styles.flatMap((style) =>
            pieces
              .filter((piece) => style.start < piece.end && style.end > piece.start)
              .map((piece) => ({
                ...style,
                start: Math.max(style.start, piece.start),
                end: Math.min(style.end, piece.end),
              })),
          )
        : styles;
      for (const range of ranges.toReversed()) {
        let from = Math.max(structural, promptPrefix, range.start - start);
        let to = Math.min(line.length, range.end - start);
        if (to <= from) continue;
        const content = line.slice(from, to);
        if (prompt || !range.css.includes('white-space:')) {
          from += content.length - content.trimStart().length;
          to -= content.length - content.trimEnd().length;
        }
        if (to <= from) continue;
        const open = `${prefix}${replacements.size}\uE001`;
        // The bubble carries the prompt's backing; inline text keeps its
        // foreground/emphasis without copying terminal-width padding.
        const css =
          prompt && range.css.includes('background-color:')
            ? range.css
                .split(';')
                .filter((declaration) => !/^(?:background-color|white-space):/.test(declaration))
                .join(';')
            : range.css;
        const href =
          range.href && /^https?:\/\//i.test(range.href)
            ? range.href
                .replace(/&/g, '&amp;')
                .replace(/"/g, '&quot;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
            : undefined;
        const source = anchorText
          ? ` data-ripple-start="${start + from}" data-ripple-end="${start + to}"`
          : '';
        const style = css ? ` style="${css}"` : '';
        replacements.set(
          open,
          href
            ? `<a href="${href}"${source}${style}>`
            : `<span${source}${range.action !== undefined ? ` data-ripple-action="${range.action}" data-ripple-kind="${range.actionKind}" role="${range.actionRole}" tabindex="0"` : ''}${style}>`,
        );
        const close = `${prefix}${replacements.size}\uE001`;
        replacements.set(close, href ? '</a>' : '</span>');
        line = line.slice(0, from) + open + line.slice(from, to) + close + line.slice(to);
      }
      return prompt ? line.trimEnd() : line;
    })
    .join('\n');
  const raw = `${prefix}\\d+\uE001`;
  const encoded = `${encodeURIComponent(prefix)}\\d+${encodeURIComponent('\uE001')}`;
  const attributes = new RegExp(`${raw}|${encoded}`, 'gi');
  return {
    text: marked,
    cleanLink: (href: string) => href.replace(attributes, ''),
    restore: (html: string) => {
      // Markdown linkification URI-encodes private style markers inside hrefs.
      // They are presentation only: never restore tags into an attribute or
      // allow those bytes to become part of the destination.
      html = html.replace(/<[^>]*>/g, (tag) => tag.replace(attributes, ''));
      return html.replace(new RegExp(raw, 'g'), (marker) => replacements.get(marker) ?? marker);
    },
  };
}
