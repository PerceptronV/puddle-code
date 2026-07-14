/** Branch-name-safe slug from a session title; may legitimately be ''. */
export function slugify(title: string | null | undefined): string {
  return (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * Branch-name-safe slug from the session's first prompt: the opening words,
 * cut at a word boundary so 'fix the flaky auth test in ci' → 'fix-the-flaky-auth-test'.
 */
export function promptSlug(prompt: string | null | undefined): string {
  const full = slugify(prompt);
  if (full.length <= 28) return full;
  const cut = full.slice(0, 28);
  const boundary = cut.lastIndexOf('-');
  return boundary > 8 ? cut.slice(0, boundary) : cut;
}
