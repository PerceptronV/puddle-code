import { terminalMarkdownToHtml } from '../../editor/previews/markdown/markdown';
import { markRippleStyles, type RippleStyle } from './cell-style';
import {
  rippleInputBorder,
  ripplePromptPrefix,
  ripplePromptSummary,
  rippleWorkingLine,
} from './agent-layout';

/** Keep aligned output literal even when it resembles Markdown. */
export function rippleHtml(
  text: string,
  startInline = false,
  endInline = false,
  options: {
    styles?: RippleStyle[];
    agentType?: string;
    background?: string;
    anchorText?: boolean;
    topOfScreen?: boolean;
  } = {},
): string {
  const originalLines = text.split('\n');
  const summaryRow =
    options.topOfScreen && ripplePromptSummary(originalLines[0] ?? '', options.agentType);
  let offset = 0;
  const offsets: number[] = [];
  const prefixes = originalLines.map((line) => {
    offsets.push(offset);
    const prefix = ripplePromptPrefix(
      line,
      options.agentType,
      options.styles,
      offset,
      options.background,
    );
    offset += line.length + 1;
    return prefix;
  });
  const promptEnds = prefixes.map((prefix, row) => {
    if (!prefix || options.agentType === 'opencode' || (row === 0 && summaryRow)) return row;
    let end = row;
    for (let next = row + 1; next < originalLines.length; next++) {
      const line = originalLines[next]!;
      if (!line.trim()) {
        // A blank paragraph belongs to the prompt only when another indented
        // continuation follows. A reply's leading marker remains outside it.
        let after = next + 1;
        while (after < originalLines.length && !originalLines[after]!.trim()) after++;
        if (!originalLines[after]?.startsWith(' '.repeat(prefix)) || prefixes[after]) break;
      } else if (prefixes[next] || !line.startsWith(' '.repeat(prefix))) break;
      end = next;
    }
    return end;
  });
  const promptIndents = [...prefixes];
  promptEnds.forEach((end, row) => {
    for (let next = row + 1; next <= end; next++) promptIndents[next] = prefixes[row]!;
  });
  const marked = markRippleStyles(text, options.styles ?? [], promptIndents, options.anchorText);
  text = marked.text;
  const render = (source: string) => terminalMarkdownToHtml(source, marked.cleanLink);
  // CLIs hard-wrap prose themselves, so those newlines must reflow. Strip the
  // conventional two-column reply gutter while preserving code indentation.
  const rawLines = text.split('\n');
  const gutter =
    rawLines.some((line) => /^ {2}\S/.test(line)) &&
    rawLines.every((line) => !line.trim() || /^ {2}|^[•●⏺✦›❯]/.test(line));
  const lines = rawLines.map((line) =>
    (gutter ? line.replace(/^ {2}/, '') : line)
      .replace(/^[•●⏺✦] (?=#)/, '')
      .replace(/^(\s*)[•●⏺✦] /, '$1- '),
  );
  const output: string[] = [];
  const promptBorders = new Set<number>();
  for (let row = 0; row < prefixes.length; row++) {
    if (!prefixes[row]) continue;
    if (rippleInputBorder(originalLines[row - 1] ?? '', options.agentType))
      promptBorders.add(row - 1);
    for (let next = row + 1; next < originalLines.length; next++) {
      if (rippleInputBorder(originalLines[next]!, options.agentType)) {
        promptBorders.add(next);
        break;
      }
      if (!originalLines[next]!.trim() || prefixes[next] || /^[•●⏺✦]/.test(originalLines[next]!))
        break;
    }
  }
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) output.push(render(prose.join('\n')));
    prose = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (promptBorders.has(index)) {
      flush();
      continue;
    }
    if (rippleWorkingLine(originalLines[index]!, options.agentType)) {
      flush();
      output.push(literal(rawLines[index]!));
      continue;
    }
    if (prefixes[index]) {
      flush();
      const summary = index === 0 && summaryRow;
      const contentOffset = offsets[index]! + prefixes[index]!;
      const backing = options.styles?.find(
        (range) =>
          range.end > contentOffset &&
          range.start < offsets[index]! + originalLines[index]!.length &&
          range.css.includes('background-color:'),
      );
      const bubbleStyle = backing?.css
        .split(';')
        .filter((declaration) => /^(?:background-color|color):#[\da-f]{6}$/i.test(declaration))
        .join(';');
      const prompt = [rawLines[index]!.slice(prefixes[index])];
      if (options.agentType === 'opencode') {
        while (index + 1 < lines.length && prefixes[index + 1]) {
          index++;
          prompt.push(rawLines[index]!.slice(prefixes[index]));
        }
      } else {
        const end = promptEnds[index]!;
        const indent = prefixes[index]!;
        while (index < end) prompt.push(rawLines[++index]!.slice(indent));
      }
      output.push(
        `<div class="ripple-user-turn"${summary ? ' data-ripple-summary="true" role="button" tabindex="0"' : ''}${bubbleStyle ? ` style="${bubbleStyle}"` : ''}>${render(prompt.join('\n'))}</div>`,
      );
      continue;
    }
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      flush();
      const block = [line];
      let complete = false;
      while (++index < lines.length) {
        const next = lines[index]!;
        block.push(next);
        const closing = /^\s*(`{3,}|~{3,})\s*$/.exec(next);
        if (closing && closing[1]![0] === fence[1]![0] && closing[1]!.length >= fence[1]!.length) {
          complete = true;
          break;
        }
      }
      output.push(complete ? render(block.join('\n')) : literal(block.join('\n')));
    } else if (
      /^(?: {4}|\t|\s*\d+\s*[+-])|[\u2500-\u259f]|\S {2,}\S/.test(
        gutter ? originalLines[index]!.replace(/^ {2}/, '') : originalLines[index]!,
      ) ||
      /^(?:const|let|var)\s+\w+\s*[:=]|^console\.\w+\(/.test(originalLines[index]!.trimStart())
    ) {
      flush();
      const block = [line];
      while (
        index + 1 < lines.length &&
        !prefixes[index + 1] &&
        !promptBorders.has(index + 1) &&
        (/^(?: {4}|\t|\s*\d+\s*[+-])|[\u2500-\u259f]|\S {2,}\S/.test(
          gutter ? originalLines[index + 1]!.replace(/^ {2}/, '') : originalLines[index + 1]!,
        ) ||
          /^(?:const|let|var)\s+\w+\s*[:=]|^console\.\w+\(/.test(
            originalLines[index + 1]!.trimStart(),
          ))
      )
        block.push(lines[++index]!);
      output.push(literal(block.join('\n')));
    } else prose.push(line);
  }
  flush();
  let html = output.join('');
  // A shared rich-output match can split a paragraph around inline maths.
  // Unwrap only that boundary paragraph, retaining all other block structure.
  if (startInline) html = html.replace(/^<p>([\s\S]*?)<\/p>\n?/, '$1');
  if (endInline) html = html.replace(/<p>((?:(?!<p>)[\s\S])*)<\/p>\n?$/, '$1');
  if (startInline && /^\s/.test(text)) html = ` ${html}`;
  if (endInline && /\s$/.test(text)) html += ' ';
  return marked.restore(html);
}

function literal(text: string): string {
  const art = /[\u2500-\u259f]/.test(text) ? ' class="ripple-terminal-art"' : '';
  return `<pre${art}><code>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</code></pre>`;
}
