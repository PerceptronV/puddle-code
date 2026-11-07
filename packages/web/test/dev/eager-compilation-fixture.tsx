import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CompilationStatusResponse, CompilationTargetRequest } from '@puddle/shared';
import { CompilationWatcher } from '../../src/features/editor/compilation/CompilationWatcher';
import {
  browserTransport,
  installBrowserTransport,
} from '../../src/lib/transport/browser-transport';

/** Browser lifecycle with a synthetic host: never compiles or connects to a daemon. */
export function mountEagerCompilation(failInitial = false) {
  const original = browserTransport();
  if (original?.scope !== 'ui-preview') throw new Error('Requires UI preview');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const target: CompilationTargetRequest = {
    source: {
      session: '00000000-0000-0000-0000-000000000000',
      path: 'paper.tex',
      root: '/preview',
    },
    provider: 'latex',
  };
  const queryKey = ['compilation-status', target];
  const idle = (): CompilationStatusResponse => ({
    provider: 'latex',
    mode: 'on_demand',
    state: 'idle',
    revision: 0,
    result: null,
    error: null,
  });
  let snapshot = idle();
  // A previously running daemon may have much higher revisions than its replacement.
  let revision = 9;
  const modes: string[] = [];
  const results: Array<{ revision: number; pane: string }> = [];
  const failures: string[] = [];
  const complete = () => {
    revision++;
    snapshot = {
      provider: 'latex',
      mode: 'eager',
      state: 'succeeded',
      revision,
      error: null,
      result: {
        provider: 'latex',
        executor: 'example',
        revision,
        source: target.source,
        artifacts: [],
      },
    };
  };
  installBrowserTransport({
    ...original,
    request: async (method, path, body, signal) => {
      if (path === '/api/compilation/status') return Response.json(snapshot);
      if (path !== '/api/compilation/mode') return original.request(method, path, body, signal);
      const mode = (body as { mode: string }).mode;
      modes.push(mode);
      if (mode === 'on_demand') snapshot = { ...snapshot, mode };
      else if (failInitial) {
        failInitial = false;
        snapshot = {
          ...snapshot,
          mode: 'eager',
          state: 'failed',
          revision: ++revision,
          error: { code: 'compile_failed', message: 'Broken source' },
        };
        return Response.json({ error: snapshot.error }, { status: 422 });
      } else complete();
      return Response.json(snapshot);
    },
  });
  const container = document.createElement('div');
  document.body.append(container);
  let move!: (pane: string) => void;
  function Harness() {
    const [pane, setPane] = useState('first');
    move = setPane;
    return (
      <CompilationWatcher
        target={target}
        sourceKey="paper"
        leafId={pane}
        onResult={(_key, pane, result) => results.push({ revision: result.revision, pane })}
        onError={(_key, failure) => failures.push(failure.message)}
        onRunningChange={() => undefined}
      />
    );
  }
  const root = createRoot(container);
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    ),
  );
  return {
    state: () => ({ modes, results, failures }),
    move: () => flushSync(() => move('second')),
    expire: async () => {
      snapshot = idle();
      revision = 0;
      await client.invalidateQueries({ queryKey });
    },
    externalEdit: async () => {
      complete();
      await client.invalidateQueries({ queryKey });
    },
    remove: () => {
      root.unmount();
      client.clear();
      installBrowserTransport(original);
      container.remove();
    },
  };
}
