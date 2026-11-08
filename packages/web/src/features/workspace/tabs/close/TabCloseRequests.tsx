import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';

type CloseRequests = Map<string, () => void>;
const Context = createContext<CloseRequests | null>(null);

/** Scope close controls to this workspace, including duplicate views in separate panes. */
export function TabCloseRequests({ children }: { children: ReactNode }) {
  const [requests] = useState<CloseRequests>(() => new Map());
  return <Context value={requests}>{children}</Context>;
}

export function tabCloseKey(leafId: string, tabKey: string): string {
  return JSON.stringify([leafId, tabKey]);
}

/** An unloaded or unmounted editor cannot authorise closing its tab. */
export function useRequestEditorClose() {
  const requests = useContext(Context);
  return (key: string) => requests?.get(key)?.();
}

/** Reuse the mounted editor's dirty/draft review without eagerly loading Monaco. */
export function useEditorCloseRequest(key: string | undefined, request: () => void) {
  const requests = useContext(Context);
  useLayoutEffect(() => {
    if (!requests || key === undefined) return;
    requests.set(key, request);
    return () => {
      if (requests.get(key) === request) requests.delete(key);
    };
  }, [requests, key, request]);
}
