import { describe, expect, it } from 'vitest';
import { rippleHtml } from '../../../src/features/terminal/ripple/markdown';
import { ripplePromptPrefix } from '../../../src/features/terminal/ripple/agent-layout';

describe('Ripple provider layouts', () => {
  it('removes Gemini prompt backing edges without swallowing the answer', () => {
    const html = rippleHtml('▄▄▄▄▄▄▄▄▄▄\n > User prompt\n▀▀▀▀▀▀▀▀▀▀\n✦ Answer', false, false, {
      agentType: 'gemini-cli',
    });
    expect(html).not.toMatch(/[▄▀]/);
    expect(html).toContain('</div><ul>');
    expect(html).toContain('Answer');
  });
  it.each([
    ['codex', '›'],
    ['claude-code', '❯'],
    ['gemini-cli', '>'],
  ])('renders %s user turns without swallowing replies', (agentType, marker) => {
    const html = rippleHtml(
      `${marker} First prompt\n  continued\n\n⏺ Reply\n\n${marker} Second prompt`,
      false,
      false,
      { agentType },
    );
    expect(html.match(/class="ripple-user-turn"/g)).toHaveLength(2);
    expect(html).toContain('continued</p>');
    expect(html).toContain('</div><ul>');
    expect(rippleHtml(`\`\`\`\n${marker} code\n\`\`\``, false, false, { agentType })).not.toContain(
      'ripple-user-turn',
    );
  });

  it('does not infer user roles for unknown providers or plain OpenCode drawings', () => {
    expect(ripplePromptPrefix('> quoted text', 'unknown')).toBe(0);
    expect(ripplePromptPrefix('┃  diagram label', 'opencode')).toBe(0);
  });

  it.each(['⏺', '✦'])('reflows %s assistant headings using shared Markdown', (marker) => {
    const html = rippleHtml(`${marker} ## Heading\n  Some prose\n  continued.`);
    expect(html).toContain('<h2>Heading</h2>');
    expect(html).not.toContain('<pre>');
    expect(html).not.toContain('<br>');
  });

  it('distinguishes coloured OpenCode user panels from tool panels', () => {
    const line = '┃  A user message';
    const styles = [
      { start: 0, end: 1, css: 'color:#0055ff' },
      { start: 1, end: line.length, css: 'background-color:#eeeeee' },
    ];
    expect(ripplePromptPrefix(line, 'opencode', styles, 0, '#ffffff')).toBe(3);
    expect(
      ripplePromptPrefix(
        line,
        'opencode',
        [{ ...styles[0]!, css: 'color:#ffffff' }, styles[1]!],
        0,
        '#ffffff',
      ),
    ).toBe(0);
  });
});
