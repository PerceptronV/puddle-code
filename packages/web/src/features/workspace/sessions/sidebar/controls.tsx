import { type LucideIcon } from 'lucide-react';
import { type ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip';
import { cn } from '../../../../lib/utils';

/**
 * While any project name is being dragged, every group's session list collapses
 * (0fr grid row) so the list reads as just the project names — the dragged name
 * repositions against its neighbours, exactly like a homescreen card.
 */
export function CollapsibleSessions({
  collapsed,
  children,
}: {
  collapsed: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-200',
        collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
      )}
    >
      {children}
    </div>
  );
}

/**
 * A borderless icon button with a fill-shift hover (mirrors the left navigator).
 * `active` marks a toggled-on state with the same `bg-elevated` fill the nav
 * mode icons use (for the Scratchpad view toggle).
 */
export function IconButton({
  icon: Icon,
  label,
  onClick,
  active = false,
  // Downwards by default: these buttons head a sidebar, so this is the topmost
  // row under the title bar and an upward tooltip covered the macOS traffic
  // lights (the left navigator's icon row does the same).
  tooltipSide = 'bottom',
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
  /** The collapsed rail opens its tooltips inward (left), like the left rail. */
  tooltipSide?: 'left' | 'bottom';
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          data-sidebar-motion={`sessions-control-${label === 'Show sessions' || label === 'Hide sessions' ? 'toggle' : label}`}
          aria-pressed={active}
          className={cn(
            'flex items-center rounded-md p-1.5 transition-colors',
            active ? 'bg-elevated text-fg' : 'text-fg hover:bg-elevated',
          )}
        >
          <Icon className="size-4" />
          <span className="sr-only">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  );
}
