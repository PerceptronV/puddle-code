/**
 * Which text files offer a rendered preview beside their Monaco source
 * (SPEC §8): markdown (rendered inline, theme-styled) and HTML (a sandboxed
 * iframe). Pure and DOM-free — the tab strip branches on it eagerly, so it
 * must stay outside the lazy editor chunk, like media-kind.ts.
 */

export type PreviewKind = 'markdown' | 'html';

const BY_EXT: Record<string, PreviewKind> = {
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
  html: 'html',
  htm: 'html',
};

/** The preview kind for a path, or null when only the source view applies. */
export function previewKind(path: string): PreviewKind | null {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null; // no extension, or a leading-dot dotfile
  return BY_EXT[base.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Resolve a relative asset reference inside a previewed document (`./img.png`,
 * `../shots/a.png`, `img.png`) against the document's worktree-relative path,
 * yielding a worktree-relative path the media endpoint accepts. Returns null
 * for anything that is not a worktree-relative reference: absolute paths and
 * URLs (http, data, blob, mailto, …) are left for the browser, and references
 * escaping the worktree root are refused.
 */
export function resolvePreviewAsset(docPath: string, ref: string): string | null {
  if (
    ref === '' ||
    ref.startsWith('/') ||
    ref.startsWith('#') ||
    /^[a-z][a-z0-9+.-]*:/i.test(ref)
  ) {
    return null;
  }
  const clean = ref.split('#')[0]!.split('?')[0]!;
  if (clean === '') return null;
  const dir = docPath.split('/').slice(0, -1);
  const out = [...dir];
  for (const part of decodeURI(clean).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null; // escapes the worktree root
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.length > 0 ? out.join('/') : null;
}
