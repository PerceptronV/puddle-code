import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useWorktreeFile, useWorktreeSearch } from '../../src/lib/queries/worktree-queries';
import { installBrowserTransport } from '../../src/lib/transport/browser-transport';

export function mount(container: HTMLElement) {
  const reads: { path: string; aborted: boolean; finish: () => void }[] = [];
  installBrowserTransport({
    scope: 'isolated-cancellation',
    socket() {
      throw new Error('No sockets in this fixture');
    },
    input() {
      throw new Error('No input in this fixture');
    },
    request(_method, path, _body, signal) {
      return new Promise((resolve, reject) => {
        const read = {
          path,
          aborted: false,
          finish: () =>
            resolve(Response.json({ path, content: 'fresh', binary: false, size: 5, mtime_ms: 1 })),
        };
        reads.push(read);
        signal?.addEventListener(
          'abort',
          () => {
            read.aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  function File({ path }: { path: string }) {
    const result = useWorktreeFile('fixture', path);
    return createElement('p', null, result.data?.content ?? 'waiting');
  }
  function Search({ query }: { query: string }) {
    useWorktreeSearch('fixture', { query, regex: false, caseSensitive: false, wholeWord: false });
    return null;
  }
  function show(paths: string[], query: string) {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        ...paths.map((path, i) => createElement(File, { key: i, path })),
        query ? createElement(Search, { key: 'search', query }) : null,
      ),
    );
  }
  show(['old.ts', 'old.ts'], 'old');
  return { reads, show };
}
