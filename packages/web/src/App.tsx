import { ForwardLanding } from './features/ports/ForwardLanding';
import { QueryClientProvider } from '@tanstack/react-query';
import { Suspense, lazy, useSyncExternalStore } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { ErrorBoundary } from './components/error-boundary';
import { ContentMotion } from './components/ui/content-motion';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';
import { TokenGate } from './features/auth/TokenGate';
import { CursorHost } from './features/cursor/CursorHost';
import { ProfilePicker } from './features/profile/ProfilePicker';
import { useCurrentProfileId } from './features/profile/profile-store';
import { ShellLayout } from './features/shell/ShellLayout';
import { tokenStore } from './lib/transport/auth';
import { queryClient } from './lib/queries/client';
import { useProfiles } from './lib/queries/queries';
import { DesktopWindowGate, desktopWindowContext } from './features/windows/window-context';
import { ProjectWindowRouter } from './features/windows/navigation/project-router';

// Route-level chunks: each page loads on first visit, not up front.
const Dashboard = lazy(() =>
  import('./features/dashboard/Dashboard').then((m) => ({ default: m.Dashboard })),
);
const Workspace = lazy(() =>
  import('./features/workspace/Workspace').then((m) => ({ default: m.Workspace })),
);

function Gated() {
  const profileId = useCurrentProfileId();
  const profiles = useProfiles();
  const nativeIdentity = desktopWindowContext()?.identity;
  const fixedNativeProfile = nativeIdentity !== undefined && nativeIdentity.kind !== 'host';
  // A stored profile id that merely LOOKS valid (10-hex) but is no longer a real
  // profile — e.g. after a daemon change, or a stale id left in localStorage —
  // must fall back to the picker, not render a homepage bound to a profile that
  // doesn't exist (which showed a nameless "…" profile and an empty dashboard).
  // While the list is still loading we can't tell, so don't flash the picker.
  // Detached windows retain their fixed identity so missing-profile drafts can
  // still be recovered or explicitly discarded in their workspace.
  const unknownProfile =
    profileId !== null &&
    profiles.data !== undefined &&
    !fixedNativeProfile &&
    !profiles.data.some((p) => p.id === profileId);
  const choosingProfile = profileId === null || unknownProfile;
  return (
    <ContentMotion className="h-screen" motionKey={choosingProfile ? 'profiles' : 'frontend'}>
      {choosingProfile ? (
        <ProfilePicker />
      ) : (
        // useTransitions={false}: by default react-router v7+ wraps every location
        // update in React.startTransition, so under React 19 a navigation defers —
        // `history.push` changes the URL synchronously but the matched route only
        // renders once the transition commits, which for this app (no pending-state
        // UI, Suspense fallback=null) left clicks changing the URL while the view
        // stayed put until a reload. We want urgent, synchronous navigation.
        <BrowserRouter useTransitions={false}>
          <ProjectWindowRouter>
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
          </ProjectWindowRouter>
        </BrowserRouter>
      )}
    </ContentMotion>
  );
}

export function App() {
  const token = useSyncExternalStore(tokenStore.subscribe, tokenStore.get);
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <CursorHost />
        {/* The outer net: whatever the routed view's own boundary does not catch
            — the shell, the providers, the token gate — still says something
            rather than emptying the window (components/error-boundary). */}
        <ErrorBoundary scope="app">
          {token ? (
            window.location.pathname.startsWith('/forward/') ? (
              <ForwardLanding />
            ) : (
              <DesktopWindowGate>
                <Gated />
              </DesktopWindowGate>
            )
          ) : (
            <TokenGate />
          )}
        </ErrorBoundary>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
