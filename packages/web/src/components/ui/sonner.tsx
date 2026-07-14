import { Toaster as SonnerToaster } from 'sonner';
import { useSyncExternalStore } from 'react';
import { currentTheme, onThemeChange } from '../../lib/theme';

/** Toasts follow the active puddle theme and sit on elevated surfaces. */
export function Toaster() {
  const theme = useSyncExternalStore(onThemeChange, currentTheme);
  return (
    <SonnerToaster
      theme={theme}
      position="bottom-right"
      toastOptions={{
        style: {
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          color: 'var(--text-primary)',
        },
      }}
    />
  );
}
