import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';

type CloseRequests = Map<string, (signal?: AbortSignal) => Promise<boolean>>;
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
  return (key: string, signal?: AbortSignal, requireReady = false) => {
    const request = requests?.get(key);
    if (request) return request(signal);
    return requireReady
      ? Promise.reject(
          new Error(
            'Wait for the file tabs to load or recover the project before closing this pane',
          ),
        )
      : Promise.resolve(false);
  };
}

/** Reuse the mounted editor's dirty/draft review without eagerly loading Monaco. */
export function useEditorCloseRequest(
  key: string | undefined,
  request: (signal?: AbortSignal) => Promise<boolean>,
) {
  const requests = useContext(Context);
  useLayoutEffect(() => {
    if (!requests || key === undefined) return;
    requests.set(key, request);
    return () => {
      if (requests.get(key) === request) requests.delete(key);
    };
  }, [requests, key, request]);
}
