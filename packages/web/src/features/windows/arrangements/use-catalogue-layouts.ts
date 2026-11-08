import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supportsApplicationFeature, type SavedLayout } from '@puddle/shared';
import { toast } from 'sonner';
import { desktopBridge } from '../../../lib/desktop';
import { queryClient } from '../../../lib/queries/client';
import { fetchAllSessions, useDaemonVersion } from '../../../lib/queries/queries';
import { currentProfileId } from '../../profile/profile-store';
import type { LayoutBridge } from '../../layouts/layouts-store';
import { desktopWindowContext } from '../window-context';
import { desktopWorkingSet, useDesktopUiState } from '../use-desktop-state';
import { arrangementSignature, captureCatalogueLayout, catalogueArrangement } from './catalogue';
import { CatalogueApplication } from './catalogue-application';

const application = new CatalogueApplication();

export function useCatalogueLayouts(
  profileId: string | null,
  open: boolean,
  workspace: LayoutBridge | null,
  selectedScope: string | null,
): { native: boolean; bridge: LayoutBridge | null; busy: boolean; error: string | null } {
  const context = desktopWindowContext();
  const native = context !== null;
  const api = desktopBridge()?.windows?.layouts;
  const protocol = useDaemonVersion().data?.protocol;
  const supported =
    !!api?.apply && !!api.observe && supportsApplicationFeature(protocol, { major: 26, minor: 17 });
  const host = context?.identity.kind === 'host';
  const state = useDesktopUiState(native && host ? profileId : null);
  const busy = useSyncExternalStore(application.subscribe, application.busy);
  const projectId =
    selectedScope === 'profile'
      ? ''
      : (selectedScope ?? (workspace?.scope === 'project' ? workspace.projectId : ''));
  const scope = projectId ? 'project' : 'profile';
  const key = ['native-layout-capture', context?.identity.id, profileId, scope, projectId];
  const capture = useQuery({
    queryKey: key,
    enabled: native && host && supported && open && !!profileId && !!state?.loaded && !busy,
    retry: false,
    staleTime: 0,
    queryFn: async () => {
      if (!api || !profileId || currentProfileId() !== profileId)
        throw new Error('The active profile changed');
      const sessions = await fetchAllSessions(queryClient);
      const captured = await api.capture({ profileId, scope, ...(projectId ? { projectId } : {}) });
      if (currentProfileId() !== profileId) throw new Error('The active profile changed');
      return captureCatalogueLayout(
        captured,
        scope,
        projectId || null,
        new Map(sessions.map((session) => [session.id, session.project_id])),
      );
    },
  });
  // Checkpoint notifications retain snapshot identity, so this does not recapture itself.
  const snapshot = state?.snapshot;
  const previousSnapshot = useRef(snapshot);
  useEffect(() => {
    const changed = previousSnapshot.current !== snapshot;
    previousSnapshot.current = snapshot;
    if (changed && native && host && supported && open && snapshot && !busy)
      void queryClient.invalidateQueries({
        queryKey: ['native-layout-capture', context.identity.id],
      });
  }, [native, host, supported, open, snapshot, busy, context]);
  useEffect(() => {
    if (!native || !host || !supported || !open || busy) return;
    const refresh = () => {
      void queryClient.invalidateQueries({
        queryKey: ['native-layout-capture', context.identity.id],
      });
    };
    window.addEventListener('focus', refresh);
    const off = desktopBridge()?.onWindowFocusChange?.((focused) => {
      if (focused) refresh();
    });
    return () => {
      window.removeEventListener('focus', refresh);
      off?.();
    };
  }, [native, host, supported, open, busy, context]);

  const error =
    native && !supported
      ? 'Window layouts require an updated desktop app and host (application 26.17 or later).'
      : (capture.error?.message ?? null);
  if (!native || !host || !supported || !profileId || !state?.loaded)
    return { native, bridge: null, busy, error };

  const assertProfile = () => {
    if (currentProfileId() !== profileId) throw new Error('The active profile changed');
  };
  const bridge: LayoutBridge = {
    native: true,
    scope,
    projectId,
    layoutRef: projectId
      ? (state.snapshot.project_layouts[projectId]?.layout_ref ?? state.snapshot.layout_ref)
      : state.snapshot.layout_ref,
    signature:
      capture.error || (capture.isStale && capture.isFetching)
        ? ''
        : capture.data
          ? arrangementSignature(capture.data.window_arrangement)
          : '',
    savedSignature: (saved) => arrangementSignature(catalogueArrangement(saved)),
    capture: async () => {
      assertProfile();
      const result = await capture.refetch({ throwOnError: true });
      if (!result.data) throw new Error('The window layout could not be captured');
      assertProfile();
      return result.data;
    },
    adopt: async (saved) => {
      assertProfile();
      const owner = desktopWorkingSet(profileId)!;
      const current = owner.get();
      const slice = saved.project_id ? current.project_layouts[saved.project_id] : undefined;
      owner.update(
        slice && saved.project_id
          ? {
              project_layouts: {
                ...current.project_layouts,
                [saved.project_id]: { ...slice, layout_ref: saved.id },
              },
            }
          : { layout_ref: saved.id },
      );
      await owner.flush();
    },
    apply: async (saved: SavedLayout) => {
      assertProfile();
      const result = await application.apply(api!, {
        id: crypto.randomUUID(),
        profileId,
        scope: saved.scope,
        ...(saved.project_id ? { projectId: saved.project_id } : {}),
        arrangement: catalogueArrangement(saved),
        layoutRef: saved.id,
      });
      if (result.status !== 'committed')
        throw new Error(
          result.error ??
            (result.status === 'cancelled'
              ? 'The layout was cancelled; your previous windows remain available.'
              : 'The layout outcome is not confirmed. Load again to check its recorded outcome.'),
        );
      if (result.error) toast.warning(result.error);
      return true;
    },
  };
  return { native, bridge, busy: busy || capture.isFetching, error };
}
