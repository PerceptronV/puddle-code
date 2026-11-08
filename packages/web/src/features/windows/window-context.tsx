import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import {
  desktopWindowIdSchema,
  desktopWindowIdentitySchema,
  type DesktopWindowContext,
} from '@puddle/shared';
import { desktopBridge } from '../../lib/desktop';
import { fenceWindowInteraction } from './interaction-fence';

let context: DesktopWindowContext | null = null;
let initialising: Promise<void> | null = null;
let suspended = false;
const suspensionListeners = new Set<() => void>();
const subscribeSuspension = (listener: () => void) => {
  suspensionListeners.add(listener);
  return () => {
    suspensionListeners.delete(listener);
  };
};

/** Release existing models before installing a staged working set in this window. */
export function suspendDesktopContent(value: boolean): void {
  flushSync(() => {
    suspended = value;
    for (const listener of suspensionListeners) listener();
  });
}

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
            ...(value.stagingTransfer
              ? { stagingTransfer: desktopWindowIdSchema.parse(value.stagingTransfer) }
              : {}),
          };
          if (context.stagingTransfer) fenceWindowInteraction(true);
          const { registerDesktopWindowLifecycle } = await import('./use-desktop-state');
          await registerDesktopWindowLifecycle();
        })
      : Promise.resolve();
  }
  return initialising;
}

/** Resolve the fixed profile/presentation before mounting any workspace effects. */
export function DesktopWindowGate({ children }: { children: ReactNode }) {
  const hidden = useSyncExternalStore(subscribeSuspension, () => suspended);
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
  return ready && !hidden ? children : null;
}
