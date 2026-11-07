import { describe, expect, it } from 'vitest';
import type { IBufferCell } from '@xterm/xterm';
import { bufferWithLines } from '../../helpers/terminal-buffer';
import {
  readRippleBuffer,
  RIPPLE_MAX_CHARACTERS,
  RIPPLE_MAX_ROWS,
} from '../../../src/features/terminal/ripple/buffer';
import { rippleHtml } from '../../../src/features/terminal/ripple/markdown';
import { rippleOverrides } from '../../../src/features/terminal/ripple/preferences';
import { DEFAULT_CLIENT_SETTINGS } from '../../../src/lib/settings/client-settings';

describe('Ripple terminal projection', () => {
  it('joins soft wraps without joining hard lines or trimming word boundaries', () => {
    const buffer = bufferWithLines(
      [{ text: 'some text ' }, { text: 'continues', isWrapped: true }, { text: 'next line' }],
      10,
    );
    expect(readRippleBuffer(buffer, 10).text).toBe('some text continues\nnext line');
  });

  it('reads the current cells again after overwrites, including below the cursor', () => {
    const buffer = bufferWithLines([{ text: 'ready' }, { text: 'Approve?' }], 10);
    Object.assign(buffer, { baseY: 0, cursorY: 0 });
    expect(readRippleBuffer(buffer, 10).text).toBe('ready\nApprove?');
    const updated = bufferWithLines([{ text: 'done' }], 10);
    Object.assign(buffer, { getLine: updated.getLine, length: updated.length });
    expect(readRippleBuffer(buffer, 10).text).toBe('done');
  });

  it('projects the current alternate screen, including cells below the input cursor', () => {
    const buffer = bufferWithLines(
      [{ text: 'Agent reply' }, { text: 'Input >' }, { text: 'Status' }],
      20,
    );
    Object.assign(buffer, { type: 'alternate' });
    expect(readRippleBuffer(buffer, 20)).toEqual({
      text: 'Agent reply\nInput >\nStatus',
      truncated: false,
      alternate: true,
      parts: [{ kind: 'text', source: 'Agent reply\nInput >\nStatus' }],
    });
  });

  it('replaces alternate-screen redraws instead of accumulating obsolete content', () => {
    const buffer = bufferWithLines([{ text: 'Old reply' }], 20);
    Object.assign(buffer, { type: 'alternate' });
    expect(readRippleBuffer(buffer, 20).text).toBe('Old reply');
    const updated = bufferWithLines([{ text: 'New reply $x^2$' }], 20);
    Object.assign(buffer, { getLine: updated.getLine, length: updated.length });
    const snapshot = readRippleBuffer(buffer, 20);
    expect(snapshot.text).toBe('New reply $x^2$');
    expect(snapshot.parts).toContainEqual({ kind: 'math', source: 'x^2', display: false });
  });

  it('bounds work to recent rows and reports omitted history', () => {
    const buffer = bufferWithLines(
      Array.from({ length: 2000 }, (_, n) => ({ text: `row ${n}` })),
      80,
    );
    const snapshot = readRippleBuffer(buffer, 80);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.text.split('\n').length).toBeLessThanOrEqual(RIPPLE_MAX_ROWS);
    expect(snapshot.text).toMatch(/row 1999$/);
    expect(snapshot.text.length).toBeLessThanOrEqual(RIPPLE_MAX_CHARACTERS);
  });

  it('omits a partial wrapped line at the history boundary', () => {
    const buffer = bufferWithLines(
      Array.from({ length: RIPPLE_MAX_ROWS + 2 }, (_, n) => ({
        text: `row ${n}`,
        isWrapped: n === 2,
      })),
      20,
    );
    const snapshot = readRippleBuffer(buffer, 20);
    expect(snapshot.text).toMatch(/^row 3\n/);
  });

  it('does not expose concealed ANSI text', () => {
    const buffer = bufferWithLines([{ text: 'secret' }], 10);
    const getLine = buffer.getLine.bind(buffer);
    Object.assign(buffer, {
      getLine: (row: number) => {
        const line = getLine(row);
        if (!line) return line;
        return {
          ...line,
          getCell: (col: number, target?: IBufferCell) => {
            const cell = line.getCell(col, target);
            if (cell) cell.isInvisible = () => 1;
            return cell;
          },
        };
      },
    });
    expect(readRippleBuffer(buffer, 10).text).toBe('');
  });

  it('shares diagram and maths detection, including unfenced Mermaid and inline LaTeX', () => {
    const buffer = bufferWithLines(
      [
        { text: 'A formula $x^2$ appears here.' },
        { text: '' },
        { text: 'flowchart LR' },
        { text: '  A[Input] --> B[Output]' },
        { text: '' },
        { text: '$$' },
        { text: '\\frac{1}{2}' },
        { text: '$$' },
      ],
      80,
    );
    const snapshot = readRippleBuffer(buffer, 80);
    expect(snapshot.parts.filter((part) => part.kind !== 'text')).toEqual([
      { kind: 'math', source: 'x^2', display: false },
      { kind: 'mermaid', source: 'flowchart LR\n  A[Input] --> B[Output]', display: true },
      { kind: 'math', source: '\\frac{1}{2}', display: true },
    ]);
    expect(snapshot.parts[0]).toEqual({ kind: 'text', source: 'A formula ' });
    expect(snapshot.parts[2]).toEqual({ kind: 'text', source: ' appears here.\n\n' });
  });
});

describe('Ripple formatting', () => {
  it('reflows CLI hard-wrapped prose without extra HTML line breaks', () => {
    expect(rippleHtml('A hard-wrapped\nparagraph.')).toBe('<p>A hard-wrapped\nparagraph.</p>\n');
  });

  it('restores ANSI emphasis and Codex gutters while retaining Markdown headings and lists', () => {
    const styled = rippleHtml('  These words are bold and italic.', false, false, {
      styles: [
        { start: 18, end: 22, css: 'font-weight:700;color:#ff0000' },
        { start: 27, end: 33, css: 'font-style:italic' },
      ],
    });
    expect(styled).toContain('<span style="font-weight:700;color:#ff0000">bold</span>');
    expect(styled).toContain('<span style="font-style:italic">italic</span>');
    const html = rippleHtml(
      '• # Heading\n  A paragraph\n  continued.\n\n  • First item\n  • Second item',
    );
    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('<li>First item</li>');
    expect(html).not.toContain('<br>');
  });

  it('preserves syntax colours inside code without displaying markup as source', () => {
    const html = rippleHtml('```ts\nconst x = 1;\n```', false, false, {
      styles: [{ start: 6, end: 11, css: 'color:#ff0000' }],
    });
    expect(html).toContain('<code class="language-ts"><span style="color:#ff0000">const</span>');
  });

  it('shows Codex prompts as user turns without classifying other agents', () => {
    const source = '› A long prompt\ncontinued here.\n\nA reply.';
    expect(rippleHtml(source, false, false, { agentType: 'codex' })).toContain(
      '<div class="ripple-user-turn"><p>A long prompt\ncontinued here.</p>',
    );
    expect(rippleHtml(source)).not.toContain('ripple-user-turn');
  });

  it('renders surviving Markdown and retains code as monospace', () => {
    const html = rippleHtml(
      '# Heading\n\nA **bold** reply with `code`.\n\n```ts\nconst x = 1;\n```',
    );
    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<pre><code class="language-ts">const x = 1;');
  });

  it('keeps incomplete fences and aligned terminal text literal', () => {
    expect(rippleHtml('```js\n**unfinished**')).toContain('<pre><code>```js\n**unfinished**');
    expect(rippleHtml('NAME    STATUS\njob     ready')).toContain(
      '<pre><code>NAME    STATUS\njob     ready',
    );
    expect(rippleHtml('│ **not Markdown** │')).not.toContain('<strong>');
  });

  it('keeps maths within its surrounding paragraph', () => {
    expect(rippleHtml('Before ', false, true)).toBe('Before ');
    expect(rippleHtml(' after.', true, false)).toBe(' after.');
    expect(rippleHtml(' between ', true, true)).toBe(' between ');
  });

  it('escapes raw HTML and permits no image loads or unsafe links', () => {
    const html = rippleHtml(
      '<img src=x onerror=alert(1)>\n![image](https://example.com/a.png)\n[run](javascript:alert(1))\n[file](file:///tmp/x)\n[site](https://example.com)',
    );
    expect(html).not.toMatch(/<(?:img|script|iframe)\b/);
    expect(html).not.toMatch(/href="(?:javascript:|file:)/);
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('&lt;img');
  });
});

describe('Ripple preferences', () => {
  it('defaults off and ignores corrupt or non-boolean overrides', () => {
    expect(DEFAULT_CLIENT_SETTINGS.rippleEnabled).toBe(false);
    for (const raw of ['broken', 'null', '[]', 'true']) expect(rippleOverrides(raw)).toEqual({});
    expect(rippleOverrides('{"a":true,"b":false,"c":"true"}')).toEqual({ a: true, b: false });
  });

  it('bounds retained placement overrides', () => {
    const raw = JSON.stringify(
      Object.fromEntries(Array.from({ length: 300 }, (_, n) => [`session-${n}`, true])),
    );
    expect(Object.keys(rippleOverrides(raw))).toHaveLength(256);
    expect(rippleOverrides(raw)['session-299']).toBe(true);
    expect(rippleOverrides(raw)['session-0']).toBeUndefined();
  });
});
