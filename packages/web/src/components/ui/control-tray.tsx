import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { useTraySelection } from './use-tray-selection';
import { useTrayHover } from './use-tray-hover';
import './control-tray.css';

/** A shared control group, with an optional island surface, in either orientation. */
export function ControlTray({
  label,
  motionId,
  vertical = false,
  variant = 'actions',
  className,
  children,
}: {
  label: string;
  /** Stable identity within a TrayMotionProvider; labels are not identities. */
  motionId?: string;
  vertical?: boolean;
  variant?: 'actions' | 'selection' | 'overlay' | 'island';
  className?: string;
  children: ReactNode;
}) {
  const { trayRef, markerRef, motionKey } = useTraySelection(vertical, motionId);
  const hoverRef = useTrayHover(trayRef);
  return (
    <div
      ref={trayRef}
      role="group"
      data-variant={variant}
      aria-label={label}
      className={cn(
        'control-tray sliding-hover-tray',
        variant !== 'actions' && 'island-outline',
        vertical && 'control-tray-vertical',
        className,
      )}
    >
      <span
        ref={markerRef}
        hidden
        aria-hidden
        data-sidebar-motion={`tray-selection-${motionKey}`}
        className="control-tray-selection"
      />
      <span ref={hoverRef} aria-hidden className="tray-hover-surface" />
      {children}
    </div>
  );
}
