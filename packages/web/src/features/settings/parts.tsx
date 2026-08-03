import { useEffect, useState, type ReactNode } from 'react';
import { Input } from '../../components/ui/input';
import { cn } from '../../lib/utils';

/**
 * A numeric setting input that commits on BLUR (or Enter), never per
 * keystroke: mid-edit states — a cleared field, a half-typed number — must not
 * write through, or the value could never be retyped (a font size applying
 * instantly on '1' of '14' famously fought the user). Empty or invalid input
 * reverts to the stored value; a committed value is clamped to [min, max].
 */
export function NumberField({
  id,
  value,
  min,
  max,
  step,
  className,
  onCommit,
}: {
  id?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  // External changes (settings sync, another window) refresh the draft.
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(n)) {
      setDraft(String(value)); // revert — emptiness is not a request for 0
      return;
    }
    const clamped = Math.min(max ?? n, Math.max(min ?? n, n));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <Input
      id={id}
      type="number"
      min={min}
      max={max}
      step={step}
      className={className}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

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
