import type { RippleStyle } from './cell-style';

/** Codex pins a truncated past prompt above the scrolled conversation. */
export function ripplePromptSummary(line: string, agentType?: string): boolean {
  return agentType === 'codex' && /^\s*[›❯] .*(?:…|\.{3})\s*$/.test(line);
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
      return /^\s*[›❯>]\s/.test(line);
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

/** Documented native history shortcuts; keep encoding in xterm, including modes. */
export function rippleLatestKey(
  agentType: string | undefined,
  alternate: boolean,
  controls: string,
): (KeyboardEventInit & { input?: string }) | null {
  if (!alternate) return null;
  if (agentType === 'codex' && /Back to bottom|Earlier messages available/.test(controls))
    return { key: 'Escape', code: 'Escape', keyCode: 27 };
  if (agentType === 'gemini-cli') return { key: 'End', code: 'End', keyCode: 35, ctrlKey: true };
  // Meta+Ctrl-G has a fixed VT encoding. macOS xterm otherwise leaves Option
  // available for text composition and ignores a synthetic Alt key here.
  if (agentType === 'opencode')
    return { key: 'g', code: 'KeyG', keyCode: 71, ctrlKey: true, altKey: true, input: '\x1b\x07' };
  return null;
}
