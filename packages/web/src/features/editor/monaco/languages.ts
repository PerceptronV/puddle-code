import { monaco } from './monaco-setup';

export function editorLanguages() {
  return monaco.languages
    .getLanguages()
    .map((language) => ({
      id: language.id,
      label: language.aliases?.[0] ?? language.id,
      keywords: [...(language.aliases ?? []), ...(language.extensions ?? [])],
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Keep automatic selection consistent with the shared file buffer. */
export function languageForPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot) : '';
  if (!extension) return 'plaintext';
  if (extension.toLowerCase() === '.ipynb') return 'json';
  return (
    monaco.languages.getLanguages().find((language) => language.extensions?.includes(extension))
      ?.id ?? 'plaintext'
  );
}
