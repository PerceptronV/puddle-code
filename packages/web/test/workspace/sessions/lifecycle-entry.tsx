import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { sessionSchema } from '@puddle/shared';
import { tokenStore } from '../../../src/lib/transport/auth';
import { SessionActions as MobileActions } from '../../../src/features/mobile/SessionActions';
import {
  SessionActionsEllipsis,
  useSessionMenu,
} from '../../../src/features/workspace/sessions/SessionActions';
import { SessionTabActions } from '../../../src/features/workspace/sessions/SessionTabActions';
import { PaneSessionOverlay } from '../../../src/features/workspace/panes/PaneSessionOverlay';

const base = sessionSchema.parse({
  id: '00000000-0000-4000-8000-000000000001',
  project_id: '0000000001',
  account_id: null,
  worktree_path: '/synthetic/project',
  base_branch: 'main',
  branch: 'main',
  separate_branch: false,
  kind: 'terminal',
  agent_type: null,
  agent_session_ref: null,
  title: 'Synthetic session',
  status: 'exited',
  skip_permissions: false,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  last_activity_at: '2026-01-01T00:00:00.000Z',
});
const root = createRoot(document.getElementById('root')!);
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
tokenStore.set('synthetic-only');
function Desktop({ session }: { session: typeof base }) {
  const { menu, dialogs } = useSessionMenu(session);
  return (
    <>
      {dialogs}
      <SessionActionsEllipsis menu={menu} />
    </>
  );
}
Object.assign(window, {
  show(surface: string, patch: Partial<typeof base>, connected = true) {
    const session = { ...base, ...patch };
    const content =
      surface === 'mobile' ? (
        <MobileActions
          session={session}
          connected={connected}
          close={() => {}}
          changed={async () => {}}
        />
      ) : surface === 'desktop' ? (
        <Desktop session={session} />
      ) : surface === 'tab' ? (
        <SessionTabActions session={session} onArchived={() => {}} />
      ) : (
        <PaneSessionOverlay session={session} />
      );
    root.render(
      <QueryClientProvider client={queries}>
        <MemoryRouter>
          <div key={surface + JSON.stringify(patch) + connected}>{content}</div>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  },
});
