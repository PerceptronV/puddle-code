import MarkdownIt from 'markdown-it';
import markdownItGithubAlerts from 'markdown-it-github-alerts';

const markdown = new MarkdownIt({ html: false }).use(markdownItGithubAlerts, {
  matchCaseSensitive: true,
});

// The plugin interpolates custom titles as HTML; keep the guide's no-HTML rule.
markdown.renderer.rules.alert_open = (tokens, index) => {
  const { type, title, icon } = tokens[index]!.meta as {
    type: string;
    title: string;
    icon: string;
  };
  return `<div class="markdown-alert markdown-alert-${type}"><p class="markdown-alert-title">${icon}${markdown.utils.escapeHtml(title)}</p>`;
};

// Markdown's ordinary heading links need matching ids for the authored TOC.
markdown.core.ruler.push('guide_heading_ids', (state) => {
  const used = new Set<string>();
  for (const [index, token] of state.tokens.entries()) {
    if (token.type !== 'heading_open') continue;
    const text = (state.tokens[index + 1]?.children ?? [])
      .filter((child) => child.type === 'text' || child.type === 'code_inline')
      .map((child) => child.content)
      .join('');
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    let id = base || 'section';
    for (let suffix = 1; used.has(id); suffix += 1) id = `${base || 'section'}-${suffix}`;
    used.add(id);
    token.attrSet('id', id);
  }
});

export function renderGuideMarkdown(content: string): string {
  return markdown.render(content);
}
