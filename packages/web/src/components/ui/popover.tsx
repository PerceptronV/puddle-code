import './overlay-motion.css';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as React from 'react';
import { overlaySurface, overlayMotion } from './recipes';
import { cn } from '../../lib/utils';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

/** Anchored island with an elevated surface and shadow to denote overlap. */
export function PopoverContent({
  className,
  align = 'end',
  sideOffset = 8,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn('overlay-popover-motion z-50 p-5', overlaySurface, overlayMotion, className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
