import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';
import { TokenGate } from './features/auth/TokenGate';
import { Dashboard } from './features/dashboard/Dashboard';
import { ProfilePicker } from './features/profile/ProfilePicker';
import { useCurrentProfileId } from './features/profile/profile-store';
import { ShellLayout } from './features/shell/ShellLayout';
import { Workspace } from './features/workspace/Workspace';
import { tokenStore } from './lib/auth';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5_000 },
  },
});

function Gated() {
  const profileId = useCurrentProfileId();
  if (profileId === null) return <ProfilePicker />;
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<ShellLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/project/:id" element={<Workspace />} />
          <Route path="/project/:id/session/:sid" element={<Workspace />} />
        </Route>
      </Routes>
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
