import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/** One labelled setting: text on the left, control on the right. */
export function SettingRow({
  label,
  description,
  descriptionClassName,
  htmlFor,
  children,
  className,
}: {
  label: string;
  description?: string;
  /** Override the description tone (e.g. a warning) — defaults to muted. */
  descriptionClassName?: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-4 py-2.5', className)}>
      <label htmlFor={htmlFor} className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm text-fg">{label}</span>
        {description && (
          <span className={cn('text-xs text-fg-muted', descriptionClassName)}>{description}</span>
        )}
      </label>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function SectionTitle({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <div className="mb-2 flex flex-col gap-0.5">
      <h2 className="text-base font-semibold text-fg">{children}</h2>
      {/* Secondary hints sit on their own line, sentence case (design decision). */}
      {note && <span className="text-xs text-fg-muted">{note}</span>}
    </div>
  );
}
