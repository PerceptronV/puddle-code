import * as React from 'react';
import { cn } from '../../lib/utils';

export function Input({ className, type, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-8 w-full rounded-md bg-elevated px-2.5 text-sm text-fg placeholder:text-fg-muted transition-colors hover:bg-border/50 focus:bg-border/50 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'flex min-h-16 w-full rounded-md bg-elevated px-2.5 py-2 text-sm text-fg placeholder:text-fg-muted transition-colors hover:bg-border/50 focus:bg-border/50 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
