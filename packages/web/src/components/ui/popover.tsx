import * as PopoverPrimitive from '@radix-ui/react-popover';
import * as React from 'react';
import { cn } from '../../lib/utils';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

/** Anchored panel: elevated surface, no border, no overlay (HUMANS.md). */
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
        className={cn('z-50 rounded-lg bg-elevated p-5 shadow-2xl outline-none', className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
