import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CompilationMode, CompilationRunResponse, LayoutLeaf } from '@puddle/shared';
import { useWorkspaceCompilation } from '../../src/features/editor/compilation/use-workspace-compilation';
import { registerSaver, saverKey } from '../../src/features/editor/buffers/save-registry';
import {
  browserTransport,
  installBrowserTransport,
} from '../../src/lib/transport/browser-transport';
import { tabRefKey } from '../../src/features/workspace/layout/layout-tree';
import type { EditorTab } from '../../src/features/editor/tabs/editor-tabs';

/** Isolated React controller harness with synthetic buffers and deferred host replies. */
export function mountCompilation() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['compilation-capabilities'], {
    providers: [
      {
        id: 'example',
        display_name: 'Example',
        extensions: ['demo'],
        input_extensions: ['demo'],
        available: true,
        executor: 'examplec',
        eager: true,
      },
    ],
  });
  const tab: EditorTab = {
    kind: 'file',
    session: '00000000-0000-4000-8000-000000000001',
    path: 'input.demo',
  };
  const leaf: LayoutLeaf = {
    kind: 'leaf',
    id: 'fixture-pane',
    tabs: [{ type: 'editor', tab }],
    activeKey: tabRefKey({ type: 'editor', tab }),
  };
  const container = document.createElement('div');
  document.body.append(container);
  const events: unknown[] = [];
  const calls: Array<{
    path: string;
    body: unknown;
    resolve: (value: unknown, status?: number) => void;
  }> = [];
  const original = browserTransport();
  if (original?.scope !== 'ui-preview')
    throw new Error('This fixture requires the daemon-free preview');
  installBrowserTransport({
    ...original,
    request: async (method, path, body, signal) => {
      if (path === '/api/compilation/run' || path === '/api/compilation/mode')
        return new Promise<Response>((resolve) => {
          calls.push({
            path,
            body,
            resolve: (value, status = 200) =>
              resolve(
                new Response(JSON.stringify(value), {
                  status,
                  headers: { 'content-type': 'application/json' },
                }),
              ),
          });
        });
      return original.request(method, path, body, signal);
    },
  });
  let save: () => Promise<boolean> = async () => true;
  let saves = 0;
  const unregister = registerSaver(
    saverKey(tab.session, tab.path),
    () => {
      saves++;
      return save();
    },
    tab,
  );
  let actions!: ReturnType<typeof useWorkspaceCompilation>;
  let update!: (project: string) => void;
  let setMode!: (mode: CompilationMode) => void;
  let mode: CompilationMode = 'on_demand';
  let project = 'aaaaaaaaaa';
  let path = '';
  function Harness() {
    const [current, setCurrent] = useState(project);
    const [compileMode, setCompileMode] = useState<CompilationMode>('on_demand');
    project = current;
    mode = compileMode;
    update = setCurrent;
    setMode = setCompileMode;
    path = useLocation().pathname;
    actions = useWorkspaceCompilation({
      projectId: current,
      profileId: '1111111111',
      scopeKey: `project:${current}`,
      sessions: [],
      protocol: { major: 26, minor: 3 },
      layout: {
        tree: leaf,
        openEditorInLeaf: (id, tab) => {
          events.push({ open: id, tab });
          return id;
        },
        ensureSession: (session) => events.push({ terminal: session.id }),
        setCompileMode: (_tab, value) => {
          events.push({ mode: value });
          setCompileMode(value);
        },
      },
    });
    return (
      <div data-compilation-fixture>
        {actions.runningKeys.size}:{compileMode}:{current}
      </div>
    );
  }
  const root = createRoot(container);
  flushSync(() =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Harness />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  let pending: Promise<void> = Promise.resolve();
  return {
    run: () => {
      pending = actions.run(leaf.id, { ...tab, compile_mode: mode });
    },
    runTwice: () => {
      pending = Promise.all([actions.run(leaf.id, tab), actions.run(leaf.id, tab)]).then(
        () => undefined,
      );
    },
    changeMode: (value: CompilationMode) => {
      pending = actions.setMode({ ...tab, compile_mode: mode }, value);
    },
    seedMode: (value: CompilationMode) => flushSync(() => setMode(value)),
    project: (value: string) => flushSync(() => update(value)),
    blockSave: () => {
      let resolve!: (value: boolean) => void;
      save = () => new Promise<boolean>((done) => (resolve = done));
      return (value: boolean) => resolve(value);
    },
    finish: (index: number, value?: unknown, status?: number) => {
      const call = calls[index]!;
      const result: CompilationRunResponse = {
        provider: 'example',
        executor: 'examplec',
        source: tab,
        artifacts: [
          {
            role: 'preview',
            media_type: 'application/pdf',
            file: { session: tab.session, path: 'output.pdf' },
          },
        ],
        revision: 1,
      };
      call.resolve(value ?? result, status);
    },
    settled: () => pending,
    state: () => ({
      events,
      calls: calls.map(({ path, body }) => ({ path, body })),
      saves,
      mode,
      project,
      path,
    }),
    remove: () => {
      root.unmount();
      client.clear();
      unregister();
      installBrowserTransport(original);
      container.remove();
    },
  };
}
