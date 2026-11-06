import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { ParkedTerminalSnapshot } from './snapshot';

/** Stable portal ownership survives while an old viewer releases its xterm resources. */
export function RetainedTerminal({
  parked,
  children,
}: {
  parked: boolean;
  children(
    snapshot: ParkedTerminalSnapshot | null,
    park: (snapshot: ParkedTerminalSnapshot) => void,
    restored: () => void,
  ): ReactNode;
}) {
  const [visited, setVisited] = useState(!parked);
  const [snapshot, setSnapshot] = useState<ParkedTerminalSnapshot | null>(null);
  const restored = useCallback(() => setSnapshot(null), []);
  useEffect(() => {
    if (!parked) setVisited(true);
  }, [parked]);
  // Restored layouts may include many other projects. Never instantiate an
  // unseen viewer, and keep a compact local fallback for previously visited ones.
  if (parked && (!visited || snapshot)) return null;
  return children(snapshot, setSnapshot, restored);
}
