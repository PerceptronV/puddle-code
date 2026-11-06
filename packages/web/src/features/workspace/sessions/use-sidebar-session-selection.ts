import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useArchiveSession } from '../../../lib/queries/queries';
import { toastError } from '../../../lib/transport/errors';
import type { SessionGroup, SidebarSessionSelection } from './sidebar/types';
import { nextSessionSelection, retainVisibleSessions } from './session-selection';

/** Shared selection and batch actions for the expanded list and collapsed rail. */
export function useSidebarSessionSelection(
  sessionGroups: readonly SessionGroup[],
  onArchived: (id: string) => void,
) {
  // Sidebar selection is workspace state rather than list state so the same
  // selected conversations survive switching between the expanded list and
  // collapsed rail. The range follows their shared flattened visual order.
  const visibleSessionIds = useMemo(
    () =>
      sessionGroups.flatMap((group) =>
        (group.collapsed ? [] : group.sessions).map((session) => session.id),
      ),
    [sessionGroups],
  );
  const [selectedSessionIds, setSelectedSessionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const sessionSelectionAnchor = useRef<string | null>(null);
  useEffect(() => {
    setSelectedSessionIds((selection) => retainVisibleSessions(selection, visibleSessionIds));
    if (
      sessionSelectionAnchor.current !== null &&
      !visibleSessionIds.includes(sessionSelectionAnchor.current)
    ) {
      sessionSelectionAnchor.current = null;
    }
  }, [visibleSessionIds]);
  const selectSidebarSession = useCallback(
    (id: string, modifiers: { shift: boolean; toggle: boolean }) => {
      setSelectedSessionIds((selection) => {
        const next = nextSessionSelection(
          visibleSessionIds,
          selection,
          sessionSelectionAnchor.current,
          id,
          modifiers,
        );
        sessionSelectionAnchor.current = next.anchor;
        return next.selection;
      });
    },
    [visibleSessionIds],
  );
  const selectOnlySidebarSession = useCallback((id: string) => {
    sessionSelectionAnchor.current = id;
    setSelectedSessionIds(new Set([id]));
  }, []);
  // Sessions dropped on an archive target (rail icon / list header), or chosen
  // through a selected row's batch menu: archive every one — no confirmation,
  // nothing is destroyed (SPEC §4) — and drop their tabs.
  const archiveSession = useArchiveSession();
  const archiveSidebarSessions = useCallback(
    async (ids: readonly string[]) => {
      const uniqueIds = [...new Set(ids)];
      const results = await Promise.allSettled(
        uniqueIds.map((id) => archiveSession.mutateAsync(id)),
      );
      const archivedIds = uniqueIds.filter((_, index) => results[index]?.status === 'fulfilled');
      for (const id of archivedIds) onArchived(id);
      if (archivedIds.length > 0) {
        setSelectedSessionIds((selection) => {
          const next = new Set(selection);
          for (const id of archivedIds) next.delete(id);
          return next;
        });
        if (
          sessionSelectionAnchor.current !== null &&
          archivedIds.includes(sessionSelectionAnchor.current)
        ) {
          sessionSelectionAnchor.current = null;
        }
      }
      const failures = results.filter((result) => result.status === 'rejected');
      const firstFailure = failures[0];
      if (failures.length === 1 && firstFailure) {
        toastError(firstFailure.reason);
      } else if (failures.length > 1) {
        toast.error(`Couldn’t archive ${failures.length} of ${uniqueIds.length} sessions`);
      }
    },
    [archiveSession, onArchived],
  );
  const sidebarSessionSelection: SidebarSessionSelection = {
    ids: selectedSessionIds,
    onSelect: selectSidebarSession,
    onSelectOnly: selectOnlySidebarSession,
    onArchive: (ids) => void archiveSidebarSessions(ids),
  };

  return sidebarSessionSelection;
}
