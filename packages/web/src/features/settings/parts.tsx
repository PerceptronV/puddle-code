import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/** One labelled setting: text on the left, control on the right. */
export function SettingRow({
  label,
  description,
  htmlFor,
  children,
  className,
}: {
  label: string;
  description?: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-4 py-2.5', className)}>
      <label htmlFor={htmlFor} className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm text-fg">{label}</span>
        {description && <span className="text-xs text-fg-muted">{description}</span>}
      </label>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function SectionTitle({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      <h2 className="text-base font-semibold text-fg">{children}</h2>
      {note && <span className="text-2xs text-fg-muted">{note}</span>}
    </div>
  );
}
