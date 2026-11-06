import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GitRepository } from '@puddle/shared';
import { SourceControlRepository } from '../../src/features/changes/SourceControlRepository';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import { installBrowserTransport } from '../../src/lib/transport/browser-transport';
import '../../src/styles/app.css';

if (import.meta.env.MODE !== 'ui-preview') throw new Error('Use the daemon-free preview');
const requests: unknown[] = [];
Object.assign(window, { restoreRequests: requests });
installBrowserTransport({
  scope: 'ui-preview',
  request: async (method, path, body) => {
    requests.push({ method, path, body });
    return Response.json({ ok: true });
  },
  socket: () => {
    throw new Error('No socket in this fixture');
  },
  input: async () => undefined,
});
const repository: GitRepository = {
  root: '/synthetic',
  relative_path: '.',
  name: 'puddle',
  owning: true,
  submodule: false,
  initialised: true,
  head: 'a'.repeat(40),
  branch: 'main',
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  has_remote: false,
  staged: [],
  conflicts: [],
  unstaged: [
    { path: 'docs/roadmap/code-quality.md', status: 'modified', old_path: null },
    { path: 'notes.txt', status: 'untracked', old_path: null },
  ],
};
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <div style={{ width: 320 }}>
        <SourceControlRepository
          session="fixture"
          repository={repository}
          restoreSupported
          selected
          activePath={null}
          onSelect={() => undefined}
          onOpen={() => undefined}
        />
      </div>
    </TooltipProvider>
  </QueryClientProvider>,
);
