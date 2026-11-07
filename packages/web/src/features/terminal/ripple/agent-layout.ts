import type { RippleStyle } from './cell-style';

/** Codex pins a single-row past prompt above the scrolled conversation. */
export function ripplePromptSummary(line: string, agentType?: string): boolean {
  return agentType === 'codex' && /^[ \t]*[›❯] /.test(line);
}

/** Spinner glyphs change; the footer's text identifies the stable status row. */
export function rippleWorkingLine(line: string, agentType?: string): boolean {
  return (
    agentType === 'codex' &&
    /^[^\p{L}\p{N}\n]*Working\s*\([^)]*(?:esc|interrupt)[^)]*\)\s*$/iu.test(line)
  );
}

/** Native layouts, not inferred conversation roles. Unknown layouts stay literal. */
export function ripplePromptPrefix(
  line: string,
  agentType?: string,
  styles: RippleStyle[] = [],
  offset = 0,
  background?: string,
): number {
  const marker =
    agentType === 'codex'
      ? /^[ \t]*[›❯] /
      : agentType === 'claude-code'
        ? /^[ \t]*[❯>] /
        : agentType === 'gemini-cli'
          ? /^[ \t]*> /
          : undefined;
  if (marker) return marker.exec(line)?.[0].length ?? 0;
  if (agentType !== 'opencode') return 0;
  // OpenCode's UserMessage has an agent-coloured SplitBorder and a painted
  // body. Tool blocks use the terminal background for that border. Never turn
  // plain box drawings or tool panels into user messages based on glyphs alone.
  const border = /^([ \t]*┃ {1,2})/.exec(line);
  if (!border) return 0;
  const column = line.indexOf('┃') + offset;
  const borderStyle = styles.find((style) => style.start <= column && style.end > column);
  const foreground = /(?:^|;)color:(#[\da-f]{6})(?:;|$)/i.exec(borderStyle?.css ?? '')?.[1];
  const painted = styles.some(
    (style) =>
      style.start < offset + line.length &&
      style.end > column + 1 &&
      style.css.includes('background-color:'),
  );
  if (
    !foreground ||
    !background ||
    foreground.toLowerCase() === background.toLowerCase() ||
    !painted
  )
    return 0;
  return border[0].length;
}

export function rippleInputMarker(line: string, agentType?: string): boolean {
  switch (agentType) {
    case 'codex':
      return /^\s*[›❯>](?:\s|$)/.test(line);
    case 'claude-code':
      return /^\s*[❯>]\s/.test(line);
    case 'gemini-cli':
      return /^\s*(?:[>!*]|\(r:\))\s/.test(line);
    case 'opencode':
      return /^\s*┃/.test(line);
    default:
      return false;
  }
}

export function rippleInputBorder(line: string, agentType?: string): boolean {
  return (
    ((agentType === 'claude-code' || agentType === 'gemini-cli') &&
      /^\s*[─━]{3,}\s*$/.test(line)) ||
    (agentType === 'gemini-cli' && /^\s*[▄▀]{3,}\s*$/.test(line))
  );
}
