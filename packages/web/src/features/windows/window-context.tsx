import { useEffect, useState, type ReactNode } from 'react';
import { desktopWindowIdentitySchema, type DesktopWindowContext } from '@puddle/shared';
import { desktopBridge } from '../../lib/desktop';

let context: DesktopWindowContext | null = null;
let initialising: Promise<void> | null = null;

/** Identity is fixed for this renderer lifetime and comes only from its native owner. */
export function desktopWindowContext(): DesktopWindowContext | null {
  return context;
}

function initialise(): Promise<void> {
  if (!initialising) {
    const bridge = desktopBridge()?.windows;
    initialising = bridge
      ? bridge.context().then(async (value) => {
          context = {
            identity: desktopWindowIdentitySchema.parse(value.identity),
            hostId: value.hostId,
          };
          const { registerDesktopWindowLifecycle } = await import('./use-desktop-state');
          await registerDesktopWindowLifecycle();
        })
      : Promise.resolve();
  }
  return initialising;
}

/** Resolve the fixed profile/presentation before mounting any workspace effects. */
export function DesktopWindowGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(() => !desktopBridge()?.windows || context !== null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    void initialise().then(
      () => {
        if (active) setReady(true);
      },
      (error: unknown) => {
        if (active)
          setError(error instanceof Error ? error : new Error('Could not restore this window'));
      },
    );
    return () => {
      active = false;
    };
  }, []);
  if (error) throw error;
  return ready ? children : null;
}
