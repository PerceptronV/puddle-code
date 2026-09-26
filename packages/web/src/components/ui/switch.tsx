import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as React from 'react';
import { cn } from '../../lib/utils';

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer group/switch inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {/* A larger touch target must not stretch the visible track. */}
      <span className="pointer-events-none inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-border transition-colors group-hover/switch:bg-border/70 group-data-[state=checked]/switch:bg-action">
        <SwitchPrimitive.Thumb className="block size-4 rounded-full bg-ground shadow-sm transition-transform data-[state=checked]:translate-x-[1.125rem] data-[state=unchecked]:translate-x-0.5" />
      </span>
    </SwitchPrimitive.Root>
  );
}
