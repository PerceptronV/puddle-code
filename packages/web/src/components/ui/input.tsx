import * as React from 'react';
import { cn } from '../../lib/utils';
import { fieldSurface } from './recipes';

export function Input({ className, type, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type={type}
      className={cn('flex h-8 w-full px-2.5', fieldSurface, className)}
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
      className={cn('flex min-h-16 w-full px-2.5 py-2', fieldSurface, className)}
      {...props}
    />
  );
}
