import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';

/**
 * Lets any workspace descendant — the file explorer today, terminal file-links
 * in Phase 4 (Task 12) — open a file in the editor without prop-drilling or
 * importing the heavy editor chunk. Mirrors `new-session-context.tsx`'s
 * setHandler pattern: the workspace registers the real handler via
 * `useEditorHandler`, and `useEditor().openFile` routes through it.
 *
 * EAGER-SAFE by design (Workspace and, later, Terminal import it): it carries
 * callbacks only, never monaco or anything behind the lazy editor boundary.
 * The handler itself only mutates ui-state (add/focus a tab) and records a
 * pending reveal, so it works even when no editor tab is open yet and the
 * lazy editor chunk has not loaded.
 */

/** A caret to reveal after the file's model finishes loading (Phase 4 file-links). */
export interface EditorPosition {
  line: number;
  column?: number;
}

/**
 * A pending reveal the workspace hands to the editor zone: which tab, where to
 * put the caret, and a `nonce` so re-opening the same position re-triggers the
 * reveal (React would otherwise see identical props and skip it).
 */
export interface RevealTarget extends EditorPosition {
  session: string;
  path: string;
  nonce: number;
}

export type OpenFile = (sessionId: string, path: string, position?: EditorPosition) => void;

interface EditorContextValue {
  /** Opens/focuses a file if a workspace is mounted; otherwise a muted toast. */
  openFile: OpenFile;
  /** null when no workspace editor zone is mounted — see `openFile`. */
  handler: OpenFile | null;
  setHandler(handler: OpenFile | null): void;
}

const EditorContext = createContext<EditorContextValue>({
  openFile: () => undefined,
  handler: null,
  setHandler: () => undefined,
});

export function EditorProvider({ children }: { children: ReactNode }) {
  const [handler, setHandlerState] = useState<OpenFile | null>(null);
  const setHandler = useCallback((h: OpenFile | null) => setHandlerState(() => h), []);
  const openFile = useCallback<OpenFile>(
    (sessionId, path, position) => {
      if (!handler) {
        // No workspace mounted (e.g. a stray deep-link) — fail soft, not silent.
        toast('The editor is not ready yet.');
        return;
      }
      handler(sessionId, path, position);
    },
    [handler],
  );
  const value = useMemo(() => ({ openFile, handler, setHandler }), [openFile, handler, setHandler]);
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor(): { openFile: OpenFile } {
  const { openFile } = useContext(EditorContext);
  return { openFile };
}

/**
 * Registers `handler` as the active `openFile` implementation while mounted.
 * The handler is captured in a ref and wrapped in a stable function so it is
 * registered exactly once — callers may pass a fresh closure each render (it
 * usually closes over ui-state) without re-registering on every render.
 */
export function useEditorHandler(handler: OpenFile): void {
  const { setHandler } = useContext(EditorContext);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const stable: OpenFile = (sessionId, path, position) => ref.current(sessionId, path, position);
    setHandler(stable);
    return () => setHandler(null);
  }, [setHandler]);
}
