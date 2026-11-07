import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  CompilationFailure,
  CompilationRunResponse,
  CompilationTargetRequest,
} from '@puddle/shared';
import { setCompilationMode, useCompilationStatus } from '../../../lib/queries/compilation-queries';
import { failureFrom } from './compilation-errors';
import { hasCompilationConflict, subscribeAllConflicts } from '../conflicts/conflict-store';

/**
 * Browser bridge for one persisted eager source. The daemon owns filesystem
 * observation and build coalescing; this lightweight poll only delivers the
 * newest completed revision to the already-authenticated cockpit.
 * Status revisions advance when a build starts, while the retained result
 * still describes the last successful build. Deduplicate by result revision
 * so observing an in-flight build cannot consume its eventual PDF refresh.
 */
export function CompilationWatcher({
  target,
  sourceKey,
  leafId,
  onResult,
  onError,
  onRunningChange,
  inputExtensions = [],
}: {
  target: CompilationTargetRequest;
  sourceKey: string;
  leafId: string;
  onResult: (sourceKey: string, leafId: string, result: CompilationRunResponse) => void;
  onError: (sourceKey: string, failure: CompilationFailure) => void;
  onRunningChange: (sourceKey: string, running: boolean) => void;
  inputExtensions?: readonly string[];
}) {
  const [registered, setRegistered] = useState(false);
  const qc = useQueryClient();
  const presentation = useRef({ leafId, onResult, onError, onRunningChange });
  presentation.current = { leafId, onResult, onError, onRunningChange };
  const register = useRef<(() => void) | null>(null);
  const observedEager = useRef(false);
  const deliveredRevision = useRef(-1);
  const deliveredErrorRevision = useRef(-1);
  const conflicted = useSyncExternalStore(subscribeAllConflicts, () =>
    hasCompilationConflict(target.source, inputExtensions),
  );
  const stableTarget = useMemo(
    () => ({
      source: {
        session: target.source.session,
        path: target.source.path,
        ...(target.source.root !== undefined ? { root: target.source.root } : {}),
      },
      ...(target.provider !== undefined ? { provider: target.provider } : {}),
      ...(target.profile_id !== undefined ? { profile_id: target.profile_id } : {}),
      ...(target.project_id !== undefined ? { project_id: target.project_id } : {}),
    }),
    [
      target.provider,
      target.profile_id,
      target.project_id,
      target.source.session,
      target.source.path,
      target.source.root,
    ],
  );

  useEffect(() => {
    if (conflicted) {
      setRegistered(false);
      return;
    }
    let cancelled = false;
    let registering = false;
    const queryKey = ['compilation-status', stableTarget];
    const ensureRegistered = () => {
      if (cancelled || registering) return;
      registering = true;
      setRegistered(false);
      observedEager.current = false;
      deliveredRevision.current = -1;
      deliveredErrorRevision.current = -1;
      presentation.current.onRunningChange(sourceKey, true);
      // Retire an old status fetch before registration: an idle cached reply
      // must not overwrite the newly registered target and trigger a loop.
      void qc.cancelQueries({ queryKey, exact: true }).then(async () => {
        if (cancelled) return;
        try {
          const snapshot = await setCompilationMode({ ...stableTarget, mode: 'eager' });
          if (cancelled) return;
          qc.setQueryData(queryKey, snapshot);
          observedEager.current = snapshot.mode === 'eager';
          presentation.current.onRunningChange(sourceKey, snapshot.state === 'running');
          if (snapshot.result && snapshot.result.revision > deliveredRevision.current) {
            deliveredRevision.current = snapshot.result.revision;
            const current = presentation.current;
            current.onResult(sourceKey, current.leafId, snapshot.result);
          }
        } catch (error: unknown) {
          if (cancelled) return;
          presentation.current.onRunningChange(sourceKey, false);
          // An initial failed build still has active input watchers. Observe
          // fresh status instead of using a cached idle snapshot to retry it.
          qc.removeQueries({ queryKey, exact: true });
          presentation.current.onError(sourceKey, failureFrom(error));
        } finally {
          registering = false;
          if (!cancelled) setRegistered(true);
        }
      });
    };
    register.current = ensureRegistered;
    ensureRegistered();
    return () => {
      cancelled = true;
      register.current = null;
      presentation.current.onRunningChange(sourceKey, false);
      void setCompilationMode({ ...stableTarget, mode: 'on_demand' }).catch(() => undefined);
    };
    // Moving the source to another pane or changing presentation callbacks
    // does not revoke its daemon watcher.
  }, [stableTarget, sourceKey, qc, conflicted]);

  const status = useCompilationStatus(stableTarget, registered);
  const snapshot = status.data;
  useEffect(() => {
    if (conflicted || !registered || !snapshot) return;
    // The daemon expires unseen targets while this window is backgrounded;
    // replacement daemons also start at revision zero. Restore the persisted
    // eager choice, including its initial build and a fresh result counter.
    if (snapshot.mode === 'eager') observedEager.current = true;
    if (
      observedEager.current &&
      snapshot.mode === 'on_demand' &&
      snapshot.state === 'idle' &&
      snapshot.revision === 0
    ) {
      register.current?.();
      return;
    }
    onRunningChange(sourceKey, snapshot.state === 'running');
    if (snapshot.result && snapshot.result.revision > deliveredRevision.current) {
      deliveredRevision.current = snapshot.result.revision;
      onResult(sourceKey, leafId, snapshot.result);
    }
    if (
      snapshot.state === 'failed' &&
      snapshot.error &&
      snapshot.revision > deliveredErrorRevision.current
    ) {
      deliveredErrorRevision.current = snapshot.revision;
      onError(sourceKey, snapshot.error);
    }
  }, [conflicted, registered, snapshot, sourceKey, leafId, onResult, onError, onRunningChange]);

  return null;
}
