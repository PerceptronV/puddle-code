import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import {
  PROTOCOL_VERSION,
  projectSchema,
  sessionSchema,
  type AgentNotification,
  type DesktopNotificationRequest,
  type NotificationTarget,
} from '@puddle/shared';
import { useWaitingNotifications } from '../../src/features/shell/use-waiting-notifications';
import { Terminal } from '../../src/features/terminal/Terminal';
import { wsManager } from '../../src/lib/ws';
import '../../src/styles/app.css';

export const projectId = '1000000001';
export const profileId = '0123456789';
export const sessionIds = [1, 2, 3].map((id) => `20000000-0000-4000-8000-00000000000${id}`);
const stamp = '2026-01-01T00:00:00Z';
const project = projectSchema.parse({
  id: projectId,
  profile_id: profileId,
  repo_id: 1,
  name: 'Project',
  created_at: stamp,
  updated_at: stamp,
});
const sessions = sessionIds.map((id, i) =>
  sessionSchema.parse({
    id,
    project_id: projectId,
    account_id: 1,
    worktree_path: '/project',
    base_branch: 'main',
    branch: 'main',
    separate_branch: false,
    kind: 'agent',
    agent_type: 'codex',
    agent_session_ref: id,
    title: `Conversation ${i + 1}`,
    status: 'waiting_input',
    skip_permissions: false,
    created_at: stamp,
    updated_at: stamp,
    last_activity_at: stamp,
    ended_at: null,
  }),
);
const query = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
query.setQueryData(['sessions', 'all'], sessions);
query.setQueryData(['project', projectId], { project, sessions });
query.setQueryData(['profile-settings', profileId], {
  notifications: { desktop: true, sound: false, when_focused: false },
});
query.setQueryData(['host'], { hostname: 'Test host' });
query.setQueryData(['version'], { version: 'test', protocol: PROTOCOL_VERSION });
const delivered: DesktopNotificationRequest[] = [];
const clicks = new Set<(id: string, target?: NotificationTarget) => void>();
const events = new Set<(event: AgentNotification) => void>();
window.puddleDesktop = {
  raiseWindow() {},
  notificationTargets: true,
  async showNotification(request) {
    delivered.push(request);
    return { state: 'shown', message: null };
  },
  onNotificationClick(handler) {
    clicks.add(handler);
    return () => {
      clicks.delete(handler);
    };
  },
};
wsManager.onAgentNotification = (handler) => {
  events.add(handler);
  return () => {
    events.delete(handler);
  };
};
wsManager.attach = (_session, _term, _cols, _rows, handlers) => {
  const timer = setTimeout(() => handlers.onData('Ready\r\n', 'replay'), 0);
  return () => clearTimeout(timer);
};
wsManager.resize = () => {};
wsManager.write = () => {};
wsManager.isConnected = () => true;
Object.assign(window, {
  notificationFixture: {
    delivered: () => delivered.map((request) => request.target?.session),
    async emit(index: number) {
      const event: AgentNotification = {
        t: 'agent-notification',
        id: crypto.randomUUID(),
        session: sessionIds[index]!,
        reason: 'waiting_input',
      };
      for (const handler of events) handler(event);
      // Cached notification preferences settle before this next event-loop turn.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    click(index: number) {
      for (const handler of clicks)
        handler('native-click', { project: projectId, session: sessionIds[index]! });
    },
  },
});
function Fixture() {
  useWaitingNotifications();
  return (
    <>
      <input aria-label="Elsewhere" />
      {sessionIds.map((session, i) => (
        <div key={session} style={{ height: 180, display: i === 2 ? 'none' : undefined }}>
          <Terminal stream={session} paused={i === 2} />
        </div>
      ))}
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={query}>
    <MemoryRouter>
      <Fixture />
    </MemoryRouter>
  </QueryClientProvider>,
);
