import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as React from 'react';
import { cn } from '../../lib/utils';

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors data-[state=checked]:bg-accent data-[state=unchecked]:bg-border data-[state=unchecked]:hover:bg-border/70 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-ground shadow-sm transition-transform data-[state=checked]:translate-x-[1.125rem] data-[state=unchecked]:translate-x-0.5" />
    </SwitchPrimitive.Root>
  );
}
