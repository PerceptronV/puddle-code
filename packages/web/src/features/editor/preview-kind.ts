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
 * Resolve an asset reference inside a previewed document against the worktree:
 * relative (`img.png`, `./img.png`, `../shots/a.png`) resolves against the
 * document's directory; absolute (`/assets/logo.svg`) against the worktree
 * ROOT — a previewed document's universe is its worktree, never the host
 * filesystem. Yields a worktree-relative path the media endpoint accepts.
 * Returns null for anything else: URLs (http, data, blob, mailto, …) and
 * protocol-relative `//host/…` refs are left for the browser, fragments have
 * no file, and references escaping the worktree root are refused.
 */
export function resolvePreviewAsset(docPath: string, ref: string): string | null {
  if (
    ref === '' ||
    ref.startsWith('#') ||
    ref.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/i.test(ref)
  ) {
    return null;
  }
  const clean = ref.split('#')[0]!.split('?')[0]!;
  if (clean === '' || clean === '/') return null;
  const dir = clean.startsWith('/') ? [] : docPath.split('/').slice(0, -1);
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
