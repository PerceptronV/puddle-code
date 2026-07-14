import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Lets the workspace hand its "open new-session modal" action to the shell
 * (⌘K palette, top bar) without prop-drilling through the router.
 */
interface NewSessionContextValue {
  handler: (() => void) | null;
  setHandler(handler: (() => void) | null): void;
}

const NewSessionContext = createContext<NewSessionContextValue>({
  handler: null,
  setHandler: () => undefined,
});

export function NewSessionProvider({ children }: { children: ReactNode }) {
  const [handler, setHandlerState] = useState<(() => void) | null>(null);
  const setHandler = useCallback((h: (() => void) | null) => setHandlerState(() => h), []);
  const value = useMemo(() => ({ handler, setHandler }), [handler, setHandler]);
  return <NewSessionContext.Provider value={value}>{children}</NewSessionContext.Provider>;
}

export function useNewSession(): NewSessionContextValue {
  return useContext(NewSessionContext);
}
