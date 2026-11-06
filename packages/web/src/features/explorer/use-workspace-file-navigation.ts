import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@puddle/shared';
import type { EditorTab } from '../editor/tabs/editor-tabs';
import type { OpenFile } from '../workspace/editor-context';
import type { UiStateHandle } from '../workspace/use-ui-state';
import type { ExplorerTarget } from './use-explorer-target';
import { fileTabRevealTarget } from './file-tab-reveal';
import {
  externalBrowseRoot,
  resolveFileLinkTarget,
  type FileLinkTarget,
} from '../terminal/links/file-links';
import { registerOpenPathHandler } from '../../lib/navigation/path-open';
import { requestReveal } from '../../lib/navigation/reveal-in-tree';

/** Coordinate file links and explicit path navigation with the explorer's current binding. */
export function useWorkspaceFileNavigation({
  uiState,
  sidebarTarget,
  tabSessions,
  openFile,
  scopeKey,
  isNarrow,
  showNavigator,
}: {
  uiState: UiStateHandle;
  sidebarTarget: ExplorerTarget;
  tabSessions: Session[];
  openFile: OpenFile;
  scopeKey: string;
  isNarrow: boolean;
  showNavigator: () => void;
}) {
  const targetSession = sidebarTarget.session;
  const targetRoot = sidebarTarget.root;
  const identity = `${scopeKey}:${targetSession?.id}:${targetRoot}`;
  const epoch = useRef({ identity, token: {} });
  if (epoch.current.identity !== identity) epoch.current = { identity, token: {} };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A validated terminal link (SPEC §7): a file opens an editor tab — an
  // `external` one when it lies outside the worktree (15.2) — and a DIRECTORY
  // binds the file tree to it as a pinned browse (SPEC §8), surfacing the
  // Files navigator first so the result is actually visible.
  const [browseRequest, setBrowseRequest] = useState<{
    session: string;
    root: string;
    nonce: number;
  } | null>(null);
  const filetreeRootRef = useRef<string | null>(null);
  const [filetreeRoot, setFiletreeRoot] = useState<string | null>(null);
  const rememberFiletreeRoot = useCallback((root: string | null) => {
    filetreeRootRef.current = root;
    setFiletreeRoot(root);
  }, []);
  const revealFileTab = useCallback(
    (tab: EditorTab) => {
      const owner = tabSessions.find((session) => session.id === tab.session);
      if (tab.root === undefined && !owner) return;
      const currentFiletreeRoot =
        filetreeRootRef.current ?? targetRoot ?? targetSession?.worktree_path ?? null;
      const target = fileTabRevealTarget(
        tab,
        owner?.worktree_path ?? tab.root ?? '',
        currentFiletreeRoot,
      );

      if (isNarrow) showNavigator();
      uiState.update({
        sidebar_mode: 'files',
        ...(isNarrow ? {} : { sidebar_collapsed: false }),
      });

      if (target.browseRoot !== undefined) {
        // The standard ephemeral browse route used by command-palette paths and
        // terminal directory links: pin a live owner (a project-directory tab
        // carries the nil session id, which is not itself pinnable) and rebase
        // Files.
        const browseSession = owner?.id ?? targetSession?.id ?? tab.session;
        setBrowseRequest({ session: browseSession, root: target.browseRoot, nonce: Date.now() });
      } else {
        if (currentFiletreeRoot !== target.directory) sidebarTarget.pin(tab.session);
      }
      requestReveal({
        path: target.path,
        directory: target.directory,
      });
    },
    [sidebarTarget, tabSessions, targetRoot, targetSession, uiState, isNarrow, showNavigator],
  );
  const openFromTerminal = useCallback(
    (session: string, target: FileLinkTarget) => {
      if (target.kind === 'dir') {
        if (isNarrow) showNavigator();
        uiState.update({
          sidebar_mode: 'files',
          ...(isNarrow ? {} : { sidebar_collapsed: false }),
        });
        setBrowseRequest({ session, root: target.path, nonce: Date.now() });
        return;
      }
      const browseRoot = externalBrowseRoot(target, targetRoot);
      if (browseRoot !== null) {
        // An external file's containing directory becomes the shared Files /
        // Changes / Search location even when the current navigator stays put.
        setBrowseRequest({ session, root: browseRoot, nonce: Date.now() });
      }
      openFile(
        session,
        target.path,
        target.line !== undefined ? { line: target.line, column: target.column } : undefined,
        target.root !== undefined ? { root: target.root } : undefined,
      );
    },
    [openFile, uiState, targetRoot, isNarrow, showNavigator],
  );
  const pathSessionId = targetSession?.id ?? null;
  const openTypedPath = useCallback(
    async (path: string) => {
      if (pathSessionId === null) throw new Error('No worktree is available for this project.');
      const token = epoch.current.token;
      const target = await resolveFileLinkTarget(pathSessionId, path, { root: targetRoot });
      if (!mounted.current || epoch.current.token !== token) return;
      // A project-directory target uses the nil session id plus `root`. Files
      // resolving inside that directory omit `root` in the response (they are
      // inside the resolution base), so restore it for the external-tab API.
      const rootedTarget: FileLinkTarget =
        target.kind === 'file' && target.root === undefined && targetRoot !== undefined
          ? { ...target, root: targetRoot }
          : target;
      if (rootedTarget.kind === 'dir' && rootedTarget.relativePath !== undefined) {
        if (isNarrow) showNavigator();
        uiState.update({
          sidebar_mode: 'files',
          ...(isNarrow ? {} : { sidebar_collapsed: false }),
        });
        requestReveal({
          path: rootedTarget.relativePath,
          root: targetRoot,
          expandTarget: true,
        });
        return;
      }
      openFromTerminal(pathSessionId, rootedTarget);
    },
    [pathSessionId, targetRoot, openFromTerminal, uiState, isNarrow, showNavigator],
  );
  useEffect(() => registerOpenPathHandler(openTypedPath), [openTypedPath]);
  return { browseRequest, filetreeRoot, rememberFiletreeRoot, revealFileTab, openFromTerminal };
}
