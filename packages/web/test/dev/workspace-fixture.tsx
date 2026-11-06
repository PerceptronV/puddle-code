import { openPath } from '../../src/lib/navigation/path-open';
import { getHotkeyHandler } from '../../src/lib/navigation/hotkeys';
import { requestUntitledSave } from '../../src/features/editor/buffers/untitled-save-store';
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
  const allSessions = [
    { ...sessions[0]!, status: 'exited' as const },
    { ...sessions[1]!, project_id: secondProject.id },
  ];
  let releaseProjects!: () => void;
  const projectsReady = new Promise<void>((resolve) => (releaseProjects = resolve));
  const holds = new Map<string, { ready: Promise<void>; release: () => void }>();
  const requests: { method: string; path: string; body: unknown }[] = [];
  const sockets = new Set<EventTarget>();
  const drafts = new Map<string, string>();
  const files = new Map<string, string>();
  let draftCount = 0;
  installBrowserTransport({
    scope: 'ui-preview',
    request: async (method, path, body) => {
      const url = new URL(path, 'http://preview');
      const route = url.pathname;
      requests.push({ method, path, body });
      await holds.get(`${method} ${route}`)?.ready;
      if (route === `/api/profiles/${profile.id}/untitled` && method === 'POST') {
        const name = `untitled-${++draftCount}.md`;
        drafts.set(name, '');
        return Response.json({ name });
      }
      if (route.startsWith(`/api/profiles/${profile.id}/untitled/`)) {
        const name = route.split('/').at(-1)!;
        if (method === 'DELETE') {
          drafts.delete(name);
          return Response.json({});
        }
        if (method === 'PUT') drafts.set(name, (body as { content: string }).content);
        return Response.json({ name, content: drafts.get(name) ?? '', mtime_ms: 1 });
      }
      if (url.searchParams.get('path') === 'renamed-synthetic.md')
        return previewRequest(method, path.replace('renamed-synthetic.md', 'README.md'), body);
      if (route.endsWith('/resolve'))
        return Response.json({ kind: 'file', path: 'resolved-synthetic.md' });
      if (route.endsWith('/rename') && method === 'POST')
        return Response.json({ path: (body as { to: string }).to });
      if (route.endsWith('/archive') && method === 'POST') {
        const row = allSessions.find((s) => route === `/api/sessions/${s.id}/archive`)!;
        row.status = 'archived';
        return Response.json(row);
      }
      if (route.endsWith('/file') && url.searchParams.get('path') === 'saved-synthetic.md') {
        const key = route + url.search;
        if (method === 'PUT') files.set(key, (body as { content: string }).content);
        if (!files.has(key))
          return Response.json(
            { error: { code: 'not_found', message: 'Absent' } },
            { status: 404 },
          );
        return Response.json({
          path: 'saved-synthetic.md',
          content: files.get(key),
          binary: false,
          mtime_ms: 1,
        });
      }
      if (method === 'GET' && route === '/api/projects') {
        await projectsReady;
        return Response.json([project, secondProject]);
      }
      if (method === 'GET' && route === `/api/projects/${project.id}`)
        return Response.json({
          project,
          sessions: allSessions.filter((s) => s.project_id === project.id),
        });
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
      sockets.add(events);
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
    profile: profile.id,
    requests,
    action: (name: string) => {
      const handler = getHotkeyHandler(name);
      if (!handler) throw new Error(`No action: ${name}`);
      handler();
    },
    saveDraft: requestUntitledSave,
    openPath,
    hold: (method: string, route: string) => {
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.set(`${method} ${route}`, { ready, release });
    },
    release: (method: string, route: string) => {
      const key = `${method} ${route}`;
      holds.get(key)?.release();
      holds.delete(key);
    },
    first: project.id,
    second: secondProject.id,
    sessions: allSessions.map((s) => s.id),
    releaseProjects,
    nativeCreation: (source: string, target: string, cause: 'fork' | 'clear') => {
      const original = allSessions.find((s) => s.id === source)!;
      allSessions.push({ ...original, id: target, title: `Native ${cause}` });
      for (const socket of sockets)
        socket.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              t: 'session-switched',
              source_session: source,
              target_session: target,
              target_project: original.project_id,
              cause,
              outcome: 'rebound',
            }),
          }),
        );
      void client.invalidateQueries({ queryKey: ['sessions'] });
      void client.invalidateQueries({ queryKey: ['project', original.project_id] });
    },
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
