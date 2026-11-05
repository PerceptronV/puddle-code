import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import './control-tray.css';

/** A shared control group, with an optional island surface, in either orientation. */
export function ControlTray({
  label,
  vertical = false,
  variant = 'actions',
  className,
  children,
}: {
  label: string;
  vertical?: boolean;
  variant?: 'actions' | 'selection' | 'overlay' | 'island';
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      data-variant={variant}
      aria-label={label}
      className={cn(
        'control-tray',
        variant !== 'actions' && 'island-outline',
        vertical && 'control-tray-vertical',
        className,
      )}
    >
      {children}
    </div>
  );
}
