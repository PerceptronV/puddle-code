/** A slim labelled usage meter: 0..100 clamped, with a right-aligned value. */
export function UsageBar({
  label,
  percentage,
  hint,
}: {
  label: string;
  percentage: number;
  hint?: string;
}) {
  const pct = Math.max(0, Math.min(100, percentage));
  // Fills stay ink until high, then warn/danger — the meter reads at a glance.
  const tone = pct >= 90 ? 'bg-danger' : pct >= 75 ? 'bg-waiting' : 'bg-action';

  return (
    <span className="flex items-center gap-2">
      {/* Wide enough for the CLI's own window names ("week (all models)"). */}
      <span className="w-24 shrink-0 truncate text-2xs text-fg-muted" title={label}>
        {label}
      </span>
      <span className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border">
        <span
          className={`absolute inset-y-0 left-0 rounded-full ${tone}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="shrink-0 text-2xs tabular-nums text-fg-muted">
        {Math.round(pct)}%{hint ? ` · ${hint}` : ''}
      </span>
    </span>
  );
}
