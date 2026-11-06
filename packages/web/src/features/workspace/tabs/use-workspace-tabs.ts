import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import type { Session, TabRef } from '@puddle/shared';
import { tabKind } from '../../editor/tabs/editor-tabs';
import { wsManager } from '../../../lib/transport/ws';
import { rememberClosedTab, takeClosedTab } from './closed-tabs';
import { findLeaf, tabRefKey, type DropEdge } from '../layout/layout-tree';
import type { LayoutController } from '../layout/useLayoutTree';
import type { UiStateHandle } from '../use-ui-state';

/** Own URL restoration, terminal navigation and closed-tab history for a workspace. */
export function useWorkspaceTabs({
  layout,
  uiState,
  scopeKey,
  projectScoped,
  sessions,
  allSessions,
  projectReady,
  isNarrow,
  onNavigate,
  claimScrollDriver,
  requestDiscard,
}: {
  layout: LayoutController;
  uiState: UiStateHandle;
  scopeKey: string;
  projectScoped: boolean;
  sessions: Session[];
  allSessions: Session[] | undefined;
  projectReady: boolean;
  isNarrow: boolean;
  onNavigate: () => void;
  claimScrollDriver: (id: string) => void;
  requestDiscard: (leafId: string, ref: TabRef) => void;
}) {
  const params = useParams();
  const projectId = params['id'] ?? '';
  const activeSessionId = params['sid'] ?? null;
  const navigate = useNavigate();
  const location = useLocation();
  const notificationKey =
    (location.state as { notificationSession?: unknown } | null)?.notificationSession ===
    activeSessionId
      ? location.key
      : null;
  const route = useRef({ projectId, activeSessionId });
  route.current = { projectId, activeSessionId };
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const uiStateRef = useRef(uiState);
  uiStateRef.current = uiState;
  const allSessionsRef = useRef(allSessions);
  allSessionsRef.current = allSessions;
  const tabSessions = allSessions ?? sessions;
  const isNarrowRef = useRef(isNarrow);
  isNarrowRef.current = isNarrow;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const [phoneSelection, setPhoneSelection] = useState<string | null>(null);
  const [phoneVisited, setPhoneVisited] = useState<string[]>([]);
  const selectPhoneSession = useCallback((id: string) => {
    setPhoneSelection(id);
    setPhoneVisited((ids) => (ids.includes(id) ? ids : [...ids, id]));
  }, []);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Restore-on-open runs once per project VISIT, not per mount: switching
  // projects in the sidebar re-runs it against the new project's stored
  // active session (which per-project layouts make a distinct value).
  const [restoredProject, setRestoredProject] = useState<string | null>(null);
  const restored = restoredProject === projectId;
  // Set when the active tab is closed: the router clears the URL param a
  // render later, so this stops the deep-link effect resurrecting the tab in
  // the interim (it would otherwise leave a zombie header — no active session).
  const justClosedActive = useRef<string | null>(null);
  // A session opened from ANOTHER project's group in the sidebar (SPEC §11):
  // under project-based layouts that project keeps its own tree, so the tab
  // cannot be opened here — the gesture navigates instead, and the navigation
  // effect opens it once THAT project's layout is the live one. `pin` carries
  // whether the gesture meant permanent (a drop, a double-click) or preview (a
  // single click). This survives the switch because the query keeps the previous
  // detail, so the workspace re-renders rather than remounting.
  const pendingOpen = useRef<{ session: string; pin: boolean } | null>(null);
  // Follow an exact native switch only in the viewer that was focused on the
  // source session. Native new/clear/fork preserve both terminal tabs; explicit
  // resume keeps the existing preview-navigation behaviour.
  useEffect(
    () =>
      wsManager.onSessionSwitched((event) => {
        if (event.source_session !== activeSessionId) return;
        const creation = event.outcome === 'rebound' && event.cause !== 'resume';
        pendingOpen.current = { session: event.target_session, pin: creation };
        if (event.target_project === projectId) {
          layoutRef.current.ensureTerminal(event.target_session, {
            preview: !creation,
            ...(creation ? { keepSession: event.source_session } : {}),
          });
        }
        void navigate(`/project/${event.target_project}/session/${event.target_session}`);
      }),
    [activeSessionId, navigate, projectId],
  );

  // Restore-on-open: land on the stored active session unless the URL already
  // deep-links one. Navigation only follows a stored session of THIS project
  // (the project detail's own list decides — entering project A must not yank
  // the URL to wherever the profile last worked), so restore never waits on
  // anything beyond the detail fetch and terminals open immediately.
  // It waits for THIS project's detail (`projectDetail`), never the stale row a
  // switch renders through: the stored session is looked up in that list.
  useEffect(() => {
    if (restored || !uiState.loaded || !projectReady) return;
    setRestoredProject(projectId);
    const stored = uiState.snapshot.active_session;
    const storedSession = sessions.find((s) => s.id === stored);
    if (!activeSessionId && storedSession && storedSession.status !== 'archived') {
      void navigate(`/project/${projectId}/session/${storedSession.id}`, { replace: true });
    }
  }, [restored, uiState, projectReady, sessions, activeSessionId, navigate, projectId]);

  // A session navigation or explicit notification click ensures a terminal for
  // that session and focuses it — added to the currently focused pane if absent,
  // else just focused — and records it as the stored active session (for reload
  // restore + the left-sidebar bind). This must fire ONCE per navigation, not on
  // every render: re-running it would re-assert the session's terminal as its
  // leaf's active tab, so clicking a file tab that shares the pane would flip
  // straight back to the terminal. Hence the ref-based `uiState`/`layout` access
  // and the deps limited to what actually changes on navigation.
  useEffect(() => {
    if (!restored) return;
    if (isNarrowRef.current) {
      if (activeSessionId) {
        setPhoneSelection(activeSessionId);
        setPhoneVisited((ids) => (ids.includes(activeSessionId) ? ids : [...ids, activeSessionId]));
      }
      onNavigateRef.current();
      return;
    }
    // Navigation is how a phone picks a session — the overlay's job is done.
    onNavigateRef.current();
    if (!activeSessionId) {
      justClosedActive.current = null; // close completed; the URL caught up
      return;
    }
    // Don't re-open the tab we're closing while the URL param still lags.
    if (activeSessionId === justClosedActive.current && !notificationKey) return;
    justClosedActive.current = null;
    // A gesture that had to cross projects to reach its layout (see
    // `pendingOpen`) says how the tab lands; any other navigation is a plain
    // single click. One navigation consumes the intent whether it matched or not,
    // so a stale one cannot pin a later open.
    const intent = pendingOpen.current;
    pendingOpen.current = null;
    // Single-click navigation opens the session as an ephemeral preview tab
    // (VSCode-style); double-clicking its tab promotes it to permanent.
    layoutRef.current.ensureTerminal(activeSessionId, {
      preview: intent?.session === activeSessionId ? !intent.pin : true,
    });
    const ui = uiStateRef.current;
    if (ui.snapshot.active_session !== activeSessionId) {
      ui.update({ active_session: activeSessionId });
    }
  }, [restored, activeSessionId, notificationKey]);

  // Closing a session from the sidebar / its lifecycle menu removes its terminal
  // from the tree; if it was the URL-bound one, drop the binding.
  const closeTab = useCallback(
    (id: string) => {
      const wasActive = activeSessionId === id;
      const stillBound =
        mounted.current &&
        route.current.projectId === projectId &&
        route.current.activeSessionId === id;
      if (wasActive && stillBound) justClosedActive.current = id;
      layout.removeTerminal(id);
      if (wasActive) {
        if (uiState.current().active_session === id) uiState.update({ active_session: null });
        if (stillBound) void navigate(`/project/${projectId}`);
      }
    },
    [layout, uiState, activeSessionId, navigate, projectId],
  );
  // Activating a tab focuses its pane; activating a terminal also navigates so
  // the left sidebar binds to it. A terminal tab may belong to ANOTHER project
  // (the cross-project sidebar can open one here), so navigate to the session's
  // OWN project — otherwise the URL keeps this project and the file tree, bound
  // to a session it doesn't own, shows empty. Closing a pane tab mirrors `closeTab`.
  const onActivateTab = useCallback(
    (leafId: string, ref: TabRef) => {
      claimScrollDriver(leafId);
      layout.activate(leafId, ref);
      if (ref.type === 'terminal' && ref.session !== activeSessionId) {
        // Navigate only when the owner is KNOWN: guessing the current project
        // while the all-sessions list is still loading would bind another
        // project's session under the wrong URL (empty header + file tree).
        // The tab itself activates regardless; the URL catches up on the next
        // click once the list has landed. Already-bound sessions skip the
        // navigate — pane-body clicks would otherwise pile up history entries.
        const owner = tabSessions.find((s) => s.id === ref.session)?.project_id;
        if (owner) void navigate(`/project/${owner}/session/${ref.session}`);
      }
    },
    [layout, navigate, tabSessions, activeSessionId, claimScrollDriver],
  );
  const onCloseTab = useCallback(
    (leafId: string, ref: TabRef) => {
      // Closing an untitled tab discards its profile-store draft — confirm
      // first (the dialogue below); nothing else lists orphaned drafts.
      if (ref.type === 'editor' && tabKind(ref.tab) === 'untitled') {
        requestDiscard(leafId, ref);
        return;
      }
      // Remember where it sat so `tab.reopen` can put it back in the same pane
      // at the same position (SPEC §11). Untitled drafts return above: closing
      // one DELETES it, so there is nothing to reopen.
      const from = findLeaf(layout.tree, leafId);
      const index = from?.tabs.findIndex((t) => tabRefKey(t) === tabRefKey(ref)) ?? -1;
      rememberClosedTab(scopeKey, { leafId, index: Math.max(0, index), ref });
      layout.close(leafId, ref);
      if (ref.type === 'terminal' && ref.session === activeSessionId) {
        justClosedActive.current = ref.session;
        uiState.update({ active_session: null });
        void navigate(`/project/${projectId}`);
      }
    },
    [layout, activeSessionId, uiState, navigate, projectId, scopeKey, requestDiscard],
  );
  // `tab.reopen`: put the last closed tab back where it was — same pane, same
  // position in its strip — through the very path a drag takes (`center` drop),
  // so it lands permanent and focused. A closure whose session has since gone is
  // discarded rather than resurrected; while the full session list is still
  // loading nothing is known to be dead, so everything stays reopenable.
  const reopenClosedTab = useCallback(() => {
    const live = allSessionsRef.current;
    const alive = live
      ? new Set(live.filter((s) => s.status !== 'archived').map((s) => s.id))
      : null;
    const entry = takeClosedTab(scopeKey, (ref) => {
      if (alive === null) return true;
      const sid = ref.type === 'terminal' ? ref.session : ref.tab.session;
      return alive.has(sid);
    });
    if (!entry) return;
    const { ref } = entry;
    // The pane it came from may itself be gone (a leaf that loses its last tab
    // collapses): then the tab joins the pane being worked in, appended rather
    // than forced to a position in a strip it never belonged to.
    const home = findLeaf(layout.tree, entry.leafId);
    const leafId = home ? entry.leafId : layout.focusedLeaf.id;
    const index = home ? entry.index : undefined;
    layout.drop({ ref, fromLeafId: leafId, toLeafId: leafId, edge: 'center', index });
    // A reopened terminal claims the URL, exactly as activating its tab does.
    if (ref.type === 'terminal' && ref.session !== activeSessionId) {
      const owner = tabSessions.find((s) => s.id === ref.session)?.project_id;
      if (owner) void navigate(`/project/${owner}/session/${ref.session}`);
    }
  }, [layout, scopeKey, activeSessionId, tabSessions, navigate]);
  // A sidebar drag (file row / session row or dot) dropped onto a pane: open a
  // PERMANENT tab there through the same dropTab path strip drags use — centre
  // inserts, an edge splits — so a drag opens and positions in one gesture.
  // As an OPEN (`copy`), not a move: a file already open elsewhere gains a
  // second tab sharing its buffer rather than being yanked from its pane
  // (dropTab keeps terminals unique — those still move). A dropped session
  // also claims the URL, like activating its tab would.
  const onDropTab = useCallback(
    (leafId: string, ref: TabRef, edge: DropEdge) => {
      const owner =
        ref.type === 'terminal'
          ? tabSessions.find((s) => s.id === ref.session)?.project_id
          : undefined;
      // Under project-based layouts, a session from another project belongs in
      // THAT project's tree — dropping it here would file it under this project
      // and then navigate away from the pane it landed in, so the tab vanished
      // with the layout it was filed in. Switch projects and open it there
      // instead, permanent as a drop implies. The dropped POSITION cannot
      // follow: it names a pane in a tree that is not the destination's.
      if (projectScoped && owner !== undefined && owner !== projectId && ref.type === 'terminal') {
        pendingOpen.current = { session: ref.session, pin: true };
        void navigate(`/project/${owner}/session/${ref.session}`);
        return;
      }
      layout.drop({ ref, fromLeafId: leafId, toLeafId: leafId, edge, copy: true });
      if (ref.type === 'terminal' && ref.session !== activeSessionId && owner !== undefined) {
        void navigate(`/project/${owner}/session/${ref.session}`);
      }
    },
    [layout, activeSessionId, tabSessions, navigate, projectScoped, projectId],
  );

  return {
    closeTab,
    onActivateTab,
    onCloseTab,
    onDropTab,
    reopenClosedTab,
    phoneSelection,
    phoneVisited,
    selectPhoneSession,
  };
}
