import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--ui-radius)] font-normal transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      // Borderless (HUMANS.md): hover/active feedback is a fill shift, never a border.
      variant: {
        default: 'bg-action text-action-ink hover:bg-action-hover active:opacity-85',
        secondary: 'bg-elevated text-fg hover:bg-border/70 active:bg-border',
        ghost: 'text-fg-secondary hover:bg-elevated hover:text-fg active:bg-border/70',
        danger: 'bg-danger text-danger-ink hover:opacity-90 active:opacity-80',
      },
      size: {
        default: 'h-[var(--ui-field-height)] px-3 text-sm',
        sm: 'h-[var(--ui-control-height)] px-2 text-xs',
        lg: 'h-[var(--ui-large-control-height)] px-4 text-sm',
        icon: 'size-[var(--ui-control-height)]',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
