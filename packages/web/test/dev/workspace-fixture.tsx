import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { savedLayoutSchema, uiStateSnapshotSchema, type SavedLayout } from '@puddle/shared';
import { Workspace } from '../../src/features/workspace/Workspace';
import { NewSessionProvider } from '../../src/features/shell/new-session-context';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import {
  installBrowserTransport,
  type CockpitSocket,
} from '../../src/lib/transport/browser-transport';
import { previewRequest } from '../../src/dev/preview/requests';
import { profile, project, sessions } from '../../src/dev/preview/data';
import { profileStore } from '../../src/features/profile/profile-store';
import { tokenStore } from '../../src/lib/transport/auth';
import { initClientSettings, updateClientSettings } from '../../src/lib/settings/client-settings';
import { initTheme } from '../../src/lib/appearance/theme';
import { workingSetKey } from '../../src/features/workspace/use-ui-state';
import { makeLeaf, tabRefKey } from '../../src/features/workspace/layout/layout-tree';
import { useLayoutBridge, type LayoutBridge } from '../../src/features/layouts/layouts-store';
import '../../src/styles/app.css';

/** Real Workspace with synthetic hosts only. No request can reach a daemon. */
export function mountWorkspaceFixture() {
  if (import.meta.env.MODE !== 'ui-preview') throw new Error('Use the daemon-free preview');
  initTheme();
  initClientSettings();
  updateClientSettings({ projectBasedLayout: true, showAllProjectSessions: true });
  const secondProject = { ...project, id: '0000000003', name: 'Second project', abbrev: 'SECOND' };
  const allSessions = [sessions[0]!, { ...sessions[1]!, project_id: secondProject.id }];
  let releaseProjects!: () => void;
  const projectsReady = new Promise<void>((resolve) => (releaseProjects = resolve));
  installBrowserTransport({
    scope: 'ui-preview',
    request: async (method, path, body) => {
      const route = new URL(path, 'http://preview').pathname;
      if (method === 'GET' && route === '/api/projects') {
        await projectsReady;
        return Response.json([project, secondProject]);
      }
      if (method === 'GET' && route === `/api/projects/${project.id}`)
        return Response.json({ project, sessions: [allSessions[0]] });
      if (method === 'GET' && route === `/api/projects/${secondProject.id}`)
        return Response.json({ project: secondProject, sessions: [allSessions[1]] });
      if (method === 'GET' && route === '/api/sessions') return Response.json(allSessions);
      const session = allSessions.find((s) => route === `/api/sessions/${s.id}`);
      if (method === 'GET' && session) return Response.json(session);
      return previewRequest(method, path, body);
    },
    input: async () => {
      throw new Error('Synthetic terminal');
    },
    socket: () => {
      const events = new EventTarget();
      const socket: CockpitSocket = {
        readyState: WebSocket.OPEN,
        send: () => undefined,
        close: () => undefined,
        addEventListener: (type, listener) =>
          events.addEventListener(type, listener as EventListener),
      };
      queueMicrotask(() => {
        events.dispatchEvent(new Event('open'));
        events.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify({ t: 'authenticated' }) }),
        );
      });
      return socket;
    },
  });
  tokenStore.set('synthetic-only');
  profileStore.set(profile.id);
  const file = {
    type: 'editor' as const,
    tab: { kind: 'file' as const, session: allSessions[0]!.id, path: 'README.md' },
  };
  const tree = makeLeaf([
    { type: 'terminal', session: allSessions[0]!.id },
    { type: 'terminal', session: allSessions[1]!.id },
    file,
  ]);
  tree.activeKey = tabRefKey(file);
  sessionStorage.setItem(
    workingSetKey(profile.id),
    JSON.stringify(
      uiStateSnapshotSchema.parse({
        layout_mode: 'profile',
        layout_tree: tree,
        sidebar_collapsed: false,
        session_order: allSessions.map((s) => s.id),
      }),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let navigate!: ReturnType<typeof useNavigate>;
  let bridge: LayoutBridge | null = null;
  let saved: SavedLayout | null = null;
  function Controls() {
    navigate = useNavigate();
    bridge = useLayoutBridge();
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  root.render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <NewSessionProvider>
          <MemoryRouter initialEntries={[`/project/${project.id}`]} useTransitions={false}>
            <Controls />
            <Routes>
              <Route path="/project/:id" element={<Workspace />} />
              <Route path="/project/:id/session/:sid" element={<Workspace />} />
            </Routes>
          </MemoryRouter>
        </NewSessionProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return {
    first: project.id,
    second: secondProject.id,
    sessions: allSessions.map((s) => s.id),
    releaseProjects,
    visit: (id: string, session?: string) =>
      navigate(`/project/${id}${session ? `/session/${session}` : ''}`),
    projectMode: (value: boolean) => updateClientSettings({ projectBasedLayout: value }),
    state: () => JSON.parse(sessionStorage.getItem(workingSetKey(profile.id))!),
    bridge: () =>
      bridge
        ? { scope: bridge.scope, projectId: bridge.projectId, capture: bridge.capture() }
        : null,
    save: () => {
      if (!bridge) throw new Error('No layout bridge');
      saved = savedLayoutSchema.parse({
        id: 1,
        profile_id: profile.id,
        scope: bridge.scope,
        project_id: bridge.scope === 'project' ? bridge.projectId : null,
        name: 'Synthetic saved layout',
        ...bridge.capture(),
        created_at: profile.created_at,
        updated_at: profile.created_at,
      });
    },
    load: () => {
      if (!bridge || !saved) throw new Error('No saved layout');
      return bridge.apply(saved);
    },
    remove: () => {
      root.unmount();
      client.clear();
      installBrowserTransport(null);
    },
  };
}
