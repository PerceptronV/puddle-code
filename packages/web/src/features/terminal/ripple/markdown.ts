import { terminalMarkdownToHtml } from '../../editor/previews/markdown/markdown';

/** Keep aligned output literal even when it resembles Markdown. */
export function rippleHtml(text: string, startInline = false, endInline = false): string {
  const lines = text.split('\n');
  const output: string[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) output.push(terminalMarkdownToHtml(prose.join('\n')));
    prose = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
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
      output.push(complete ? terminalMarkdownToHtml(block.join('\n')) : literal(block.join('\n')));
    } else if (/^(?: {4}|\t)|[\u2500-\u257f]|\S {2,}\S/.test(line)) {
      flush();
      const block = [line];
      while (
        index + 1 < lines.length &&
        /^(?: {4}|\t)|[\u2500-\u257f]|\S {2,}\S/.test(lines[index + 1]!)
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
  return html;
}

function literal(text: string): string {
  return `<pre><code>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</code></pre>`;
}
