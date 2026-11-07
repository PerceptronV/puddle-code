import { describe, expect, it } from 'vitest';
import { bufferWithLines } from '../../helpers/terminal-buffer';
import { readRippleBuffer } from '../../../src/features/terminal/ripple/buffer';
import { rippleHtml } from '../../../src/features/terminal/ripple/markdown';

describe('Ripple links and source controls', () => {
  it('keeps style markers out of plain and Markdown URL destinations', () => {
    for (const source of [
      '[local preview](http://localhost:5174/e2e/fixtures/ripple.html?ripple)',
      '<https://example.com/a?x=1&y=2>',
    ]) {
      const html = rippleHtml(source, false, false, {
        styles: [
          { start: 0, end: source.length - 4, css: 'color:#123456' },
          { start: source.length - 4, end: source.length, css: 'font-weight:700' },
        ],
      });
      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!);
      expect(hrefs.length).toBeGreaterThan(0);
      expect(hrefs.every((href) => !/ripple\d|%EE%80|[\uE000\uE001<>]/i.test(href))).toBe(true);
      expect(html).not.toMatch(/[\uE000\uE001]/);
      expect(hrefs[0]).toBe(
        source.includes('localhost')
          ? 'http://localhost:5174/e2e/fixtures/ripple.html?ripple'
          : 'https://example.com/a?x=1&amp;y=2',
      );
    }
  });
  it('uses native wrapped URL and file candidates with position suffixes and alternatives', () => {
    const buffer = bufferWithLines(
      [
        { text: 'https://example.com/docs/' },
        { text: '  rendering?x=1&y=2' },
        { text: '' },
        { text: '  packages/web/src/' },
        { text: '    terminal.ts:12:3' },
      ],
      40,
    );
    const snapshot = readRippleBuffer(buffer, 40);
    expect(snapshot.actions).toContainEqual(
      expect.objectContaining({ kind: 'url', uri: 'https://example.com/docs/rendering?x=1&y=2' }),
    );
    const files = snapshot.actions?.filter((action) => action.kind === 'file') ?? [];
    expect(files.flatMap((action) => action.candidates)).toContainEqual(
      expect.objectContaining({ path: 'packages/web/src/terminal.ts', line: 12, column: 3 }),
    );
    const quoted = readRippleBuffer(
      bufferWithLines(
        [{ text: "open 'http://localhost:5174/e2e/fixtures/ripple.html?ripple'" }],
        100,
      ),
      100,
    );
    expect(quoted.actions?.[0]).toMatchObject({
      kind: 'url',
      uri: 'http://localhost:5174/e2e/fixtures/ripple.html?ripple',
    });
    expect(files.flatMap((action) => action.candidates)).toContainEqual(
      expect.objectContaining({ path: 'packages/web/src' }),
    );
  });
  it('binds Codex details controls to original rows, without treating ordinary text as controls', () => {
    const buffer = bufferWithLines(
      [{ text: '  + Show details' }, { text: 'Click Show details to read more.' }],
      50,
    );
    Object.assign(buffer, { type: 'alternate', viewportY: 0 });
    const snapshot = readRippleBuffer(buffer, 50, undefined, {}, undefined, 'codex');
    expect(snapshot.actions).toHaveLength(1);
    expect(snapshot.actions?.[0]).toMatchObject({
      kind: 'control',
      row: 0,
      col: 2,
      line: '  + Show details',
    });
    const part = snapshot.parts[0]!;
    if (part.kind !== 'text') throw new Error('Expected text');
    expect(rippleHtml(part.source, false, false, { styles: part.styles })).toContain(
      'role="button"',
    );
    expect(readRippleBuffer(buffer, 50).actions).toBeUndefined();
  });
  it('groups indented prompt lists, nested lists, code and blank paragraphs without absorbing the reply', () => {
    const source =
      '› - First point\n  - Second point\n    wrapped continuation\n    - Nested point\n  \n  Another paragraph\n  ```ts\n  const x = 1;\n  ```\n\n• Answer\n  continued answer';
    const html = rippleHtml(source, false, false, { agentType: 'codex' });
    const [prompt, answer] = html.split('</div>');
    expect(prompt).toContain('Second point');
    expect(prompt).toContain('Nested point');
    expect(prompt).toContain('Another paragraph');
    expect(prompt).toContain('const x = 1;');
    expect(prompt).not.toContain('Answer');
    expect(answer).toContain('Answer');
    expect(answer).not.toContain('Second point');
  });
});
