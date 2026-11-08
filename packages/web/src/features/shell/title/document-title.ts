import { useEffect } from 'react';

type TitleScope = 'shell' | 'workspace';
const titles = new Map<TitleScope, { text: string }>();

/** A workspace owns its title until it unmounts; host-wide status stays a fallback. */
export function registerDocumentTitle(scope: TitleScope, text: string): () => void {
  const owner = { text };
  const publish = () => {
    document.title = titles.get('workspace')?.text ?? titles.get('shell')?.text ?? 'Puddle';
  };
  titles.set(scope, owner);
  publish();
  return () => {
    if (titles.get(scope) !== owner) return;
    titles.delete(scope);
    publish();
  };
}

export function useDocumentTitle(scope: TitleScope, text: string): void {
  useEffect(() => registerDocumentTitle(scope, text), [scope, text]);
}
