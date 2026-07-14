import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Lets the workspace hand its "open new-session modal" action to the shell
 * (⌘K palette, top bar, profile panel) without prop-drilling through the
 * router. An optional account id seeds the modal's account picker — the
 * profile panel uses it to start a session on a chosen account in one click.
 */
type OpenOpts = { accountId?: number };

interface NewSessionContextValue {
  /** Opens the modal if a workspace is mounted; no-op otherwise. */
  open: (opts?: OpenOpts) => void;
  /** null when no workspace is mounted — callers gate on this. */
  handler: ((opts?: OpenOpts) => void) | null;
  setHandler(handler: ((opts?: OpenOpts) => void) | null): void;
}

const NewSessionContext = createContext<NewSessionContextValue>({
  open: () => undefined,
  handler: null,
  setHandler: () => undefined,
});

export function NewSessionProvider({ children }: { children: ReactNode }) {
  const [handler, setHandlerState] = useState<((opts?: OpenOpts) => void) | null>(null);
  const setHandler = useCallback(
    (h: ((opts?: OpenOpts) => void) | null) => setHandlerState(() => h),
    [],
  );
  const open = useCallback((opts?: OpenOpts) => handler?.(opts), [handler]);
  const value = useMemo(() => ({ open, handler, setHandler }), [open, handler, setHandler]);
  return <NewSessionContext.Provider value={value}>{children}</NewSessionContext.Provider>;
}

export function useNewSession(): NewSessionContextValue {
  return useContext(NewSessionContext);
}
