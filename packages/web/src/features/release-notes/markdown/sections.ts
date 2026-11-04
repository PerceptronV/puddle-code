import MarkdownIt from 'markdown-it';

export const RELEASE_COMPONENTS = ['cockpit', 'daemon', 'runtime', 'remote'] as const;
export type ReleaseComponent = (typeof RELEASE_COMPONENTS)[number];
export const COMPONENT_LABELS: Record<ReleaseComponent, string> = {
  cockpit: 'Cockpit',
  daemon: 'Daemon',
  runtime: 'Runtime',
  remote: 'Remote',
};

const parser = new MarkdownIt({ html: true });

/** Use Markdown's block boundaries, so headings inside examples never select a section. */
export function releaseSection(markdown: string, component: ReleaseComponent): string | null {
  const tokens = parser.parse(markdown, {});
  const lines = markdown.split('\n');
  for (const [index, token] of tokens.entries()) {
    if (
      token.type !== 'heading_open' ||
      token.tag !== 'h3' ||
      tokens[index + 1]?.content.trim().toLowerCase() !== component ||
      !token.map
    )
      continue;
    const start = token.map[0];
    const next = tokens
      .slice(index + 1)
      .find((candidate) => candidate.type === 'heading_open' && /^h[1-3]$/.test(candidate.tag));
    return lines
      .slice(start, next?.map?.[0] ?? lines.length)
      .join('\n')
      .trim();
  }
  // Do not label another component's notes as this installation or mark absent notes seen.
  return null;
}
