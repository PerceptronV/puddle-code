import type { ComponentProps, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';

/** Native disclosure semantics with Puddle's chevron instead of the browser marker. */
export function Disclosure({
  summary,
  summaryClassName,
  className,
  children,
  ...props
}: ComponentProps<'details'> & { summary: ReactNode; summaryClassName?: string }) {
  return (
    <details className={cn('[&[open]>summary>svg]:rotate-90', className)} {...props}>
      <summary
        className={cn(
          'flex cursor-pointer select-none list-none items-center gap-1 text-fg-secondary transition-colors hover:text-fg [&::-webkit-details-marker]:hidden',
          summaryClassName,
        )}
      >
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
        {summary}
      </summary>
      {children}
    </details>
  );
}
