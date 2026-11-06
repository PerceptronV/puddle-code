import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ExplorerProvider,
  useExplorer,
  useExplorerControlsOptional,
  type ExplorerCtx,
} from '../../src/features/explorer/explorer-context';
import { FileExplorer } from '../../src/features/explorer/FileExplorer';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import { installBrowserTransport } from '../../src/lib/transport/browser-transport';
import { previewRequest } from '../../src/dev/preview/requests';
import { sessions } from '../../src/dev/preview/data';
import { tokenStore } from '../../src/lib/transport/auth';
import { requestReveal } from '../../src/lib/navigation/reveal-in-tree';
import { setExplorerClipboard } from '../../src/features/explorer/clipboard-store';
import '../../src/styles/app.css';

/** Synthetic transport only; exposes semantic actions for interaction and render checks. */
export function mountExplorerFixture() {
  if (import.meta.env.MODE !== 'ui-preview') throw new Error('Use the daemon-free preview');
  const requests: { method: string; path: string; body: unknown }[] = [];
  let releaseCreate: (() => void) | undefined;
  let createReady: Promise<void> | undefined;
  installBrowserTransport({
    scope: 'ui-preview',
    request: async (method, path, body) => {
      requests.push({ method, path, body });
      if (method === 'POST' && path.includes('/create')) {
        await createReady;
        return Response.json({ path: (body as { path: string }).path });
      }
      if (method === 'POST') return Response.json({ path: 'synthetic-result' });
      return previewRequest(method, path, body);
    },
    socket: () => {
      throw new Error('Explorer fixture has no socket');
    },
    input: async () => undefined,
  });
  tokenStore.set('synthetic-only');
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  let explorer!: ExplorerCtx;
  let controlsRenders = 0;
  let setRoot!: (root: string | undefined) => void;
  let setReadOnly!: (value: boolean) => void;
  const opened: string[] = [];
  function ControlsProbe() {
    useExplorerControlsOptional();
    controlsRenders++;
    return null;
  }
  function StateProbe() {
    explorer = useExplorer();
    return null;
  }
  const extensions = new Set<string>();
  const children = (
    <>
      <ControlsProbe />
      <StateProbe />
      <FileExplorer />
    </>
  );
  function Fixture() {
    const [readOnly, update] = useState(false);
    setReadOnly = update;
    const [root, updateRoot] = useState<string | undefined>();
    setRoot = updateRoot;
    return (
      <ExplorerProvider
        session={sessions[0]!}
        root={root}
        readOnly={readOnly}
        compilableExtensions={extensions}
        activePath={null}
        onOpenFile={(_sid, path) => opened.push(path)}
      >
        {children}
      </ExplorerProvider>
    );
  }
  createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <Fixture />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return {
    requests,
    opened,
    root: (root: string | undefined) => setRoot(root),
    holdCreate: () => {
      createReady = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
    },
    releaseCreate: () => {
      releaseCreate?.();
      createReady = undefined;
    },
    clipboard: setExplorerClipboard,
    reveal: requestReveal,
    client,
    readOnly: (value: boolean) => setReadOnly(value),
    controlsRenders: () => controlsRenders,
    explorer: () => explorer,
  };
}
