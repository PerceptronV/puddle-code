import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense, lazy, useSyncExternalStore } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';
import { TokenGate } from './features/auth/TokenGate';
import { ProfilePicker } from './features/profile/ProfilePicker';
import { useCurrentProfileId } from './features/profile/profile-store';
import { ShellLayout } from './features/shell/ShellLayout';
import { tokenStore } from './lib/auth';

// Route-level chunks: each page loads on first visit, not up front.
const Dashboard = lazy(() =>
  import('./features/dashboard/Dashboard').then((m) => ({ default: m.Dashboard })),
);
const Workspace = lazy(() =>
  import('./features/workspace/Workspace').then((m) => ({ default: m.Workspace })),
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5_000 },
  },
});

function Gated() {
  const profileId = useCurrentProfileId();
  if (profileId === null) return <ProfilePicker />;
  return (
    // useTransitions={false}: by default react-router v7+ wraps every location
    // update in React.startTransition, so under React 19 a navigation defers —
    // `history.push` changes the URL synchronously but the matched route only
    // renders once the transition commits, which for this app (no pending-state
    // UI, Suspense fallback=null) left clicks changing the URL while the view
    // stayed put until a reload. We want urgent, synchronous navigation.
    <BrowserRouter useTransitions={false}>
      <Suspense fallback={null}>
        <Routes>
          <Route element={<ShellLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/project/:id" element={<Workspace />} />
            {/* The session route is the workspace; diff and history are left-
                sidebar navigators (SPEC §8), not routes. */}
            <Route path="/project/:id/session/:sid" element={<Workspace />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export function App() {
  const token = useSyncExternalStore(tokenStore.subscribe, tokenStore.get);
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        {token ? <Gated /> : <TokenGate />}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
