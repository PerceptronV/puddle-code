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
  it('anchors arbitrary output without registering label-specific controls', () => {
    const buffer = bufferWithLines([{ text: '  + Show details' }, { text: 'Open panel' }], 50);
    Object.assign(buffer, { type: 'alternate', viewportY: 0 });
    const snapshot = readRippleBuffer(buffer, 50, { first: 0, last: 2 });
    expect(snapshot.actions).toBeUndefined();
    expect(snapshot.sourceMap?.rows[0]).toMatchObject({
      row: 0,
      start: 0,
      text: '  + Show details',
    });
    const part = snapshot.parts[0]!;
    if (part.kind !== 'text') throw new Error('Expected text');
    const html = rippleHtml(part.source, false, false, { styles: part.styles, anchorText: true });
    expect(html).toContain('data-ripple-start="2"');
    expect(html).not.toContain('role="button"');
  });
  it.each(['Earlier prompt', 'Earlier prompt …', 'Earlier prompt...'])(
    'keeps pinned prompt %s separate from following diff rows',
    (label) => {
      const html = rippleHtml(
        `› ${label}\n  115 - old code\n  115 + new code\n  + Show details`,
        false,
        false,
        { agentType: 'codex', anchorText: true, topOfScreen: true },
      );
      const [prompt, reply] = html.split('</div>');
      expect(prompt).toContain('Earlier prompt');
      expect(prompt).not.toContain('old code');
      expect(prompt).toContain('data-ripple-summary="true"');
      expect(reply).toContain('<pre>');
      expect(reply).toContain('old code');
      expect(reply).toContain('new code');
    },
  );
  it('uses the themed prompt surface while retaining coloured and bold inline text', () => {
    const source = '› [Image #1] Dark prompt';
    const html = rippleHtml(source, false, false, {
      agentType: 'codex',
      styles: [
        {
          start: 0,
          end: source.length,
          css: 'color:#1234ef;background-color:#ffffff;font-weight:700',
        },
      ],
    });
    expect(html).toContain('<div class="ripple-user-turn">');
    expect(html).not.toContain('background-color');
    expect(html).toContain('color:#1234ef');
    expect(html).toContain('font-weight:700');
  });
  it('renders the first prompt bullet like subsequent bullets with source anchors and ANSI styles', () => {
    const source = '› - First point\n  - Second point';
    const html = rippleHtml(source, false, false, {
      agentType: 'codex',
      anchorText: true,
      styles: [{ start: 0, end: source.length, css: 'color:#123456' }],
    });
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).not.toContain('>- First');
  });
  it.each(['•', '◦', '·', '...', '⠋', ''])(
    'keeps Working spinner %s in a stable literal block when exposed in the reader',
    (spinner) => {
      const html = rippleHtml(`${spinner} Working (9s • esc to interrupt)`, false, false, {
        agentType: 'codex',
        anchorText: true,
      });
      expect(html).toContain('<pre>');
      expect(html).not.toContain('<ul>');
      expect(html).toContain('Working');
    },
  );
  it('does not change surrounding indentation when the Working spinner changes', () => {
    const render = (spinner: string) =>
      rippleHtml(
        [
          '• Exited (status 1) python3',
          '  └ }',
          '',
          '    Node.js v22.21.1',
          '  + 127 lines (⌃t to expand)',
          '',
          `${spinner} Working (9m 04s • esc to interrupt)`,
          '  └ Tip: Use /export',
        ].join('\n'),
        false,
        false,
        { agentType: 'codex', anchorText: true },
      )
        .replace(/<span[^>]*>|<\/span>/g, '')
        .replace('◦', '•');
    expect(render('◦')).toBe(render('•'));
  });
  it('groups indented prompt lists, nested lists, code and blank paragraphs without absorbing the reply', () => {
    const source =
      '\n› - First point\n  - Second point\n    wrapped continuation\n    - Nested point\n  \n  Another paragraph\n  ```ts\n  const x = 1;\n  ```\n\n• Answer\n  continued answer';
    const html = rippleHtml(source, false, false, { agentType: 'codex', topOfScreen: true });
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
