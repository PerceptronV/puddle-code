import { createContext, useRef, type ReactNode } from 'react';

export interface TrayPosition {
  x: number;
  y: number;
  width: number;
  height: number;
  vertical: boolean;
}

/** Remount continuity is bounded by the workspace that owns the controls. */
export const TrayMotionContext = createContext<Map<string, TrayPosition> | null>(null);
export function TrayMotionProvider({ children }: { children: ReactNode }) {
  const positions = useRef(new Map<string, TrayPosition>());
  return (
    <TrayMotionContext.Provider value={positions.current}>{children}</TrayMotionContext.Provider>
  );
}
