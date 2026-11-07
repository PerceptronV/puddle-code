import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as React from 'react';
import { compactOverlaySurface, overlayMotion } from './recipes';
import { cn } from '../../lib/utils';

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 4,
  portalled = true,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & { portalled?: boolean }) {
  const content = (
    <TooltipPrimitive.Content
      sideOffset={sideOffset}
      className={cn(
        'z-50 overflow-hidden px-2 py-1 text-xs text-fg',
        compactOverlaySurface,
        overlayMotion,
        'overlay-tooltip-motion',
        className,
      )}
      {...props}
    />
  );
  return portalled ? <TooltipPrimitive.Portal>{content}</TooltipPrimitive.Portal> : content;
}
