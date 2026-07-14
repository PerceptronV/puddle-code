import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as React from 'react';
import { cn } from '../../lib/utils';

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=unchecked]:bg-elevated disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-fg-secondary shadow-sm transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-ground data-[state=unchecked]:translate-x-0.5" />
    </SwitchPrimitive.Root>
  );
}
