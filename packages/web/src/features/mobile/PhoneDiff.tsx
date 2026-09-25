import { useMemo } from 'react';
import { phoneDiff, type DiffLine } from './phone-diff';

export function PhoneDiff({ before, after }: { before: string; after: string }) {
  const diff = useMemo(() => phoneDiff(before, after), [before, after]);
  if (!diff)
    return (
      <p className="text-sm text-fg-muted">
        Diff is too large. Use Before and After to review the text.
      </p>
    );
  if (!diff.hunks.length) return <p className="text-sm text-fg-muted">No text changes.</p>;
  return (
    <div className="phone-diff" aria-label="File diff">
      <p className="mb-3 flex gap-3 text-xs">
        <span className="text-success">+{diff.additions} added</span>
        <span className="text-danger">−{diff.deletions} removed</span>
      </p>
      {diff.hunks.map((hunk, index) => (
        <section key={index} className="phone-diff-hunk" aria-label={`Change ${index + 1}`}>
          <DiffPane label="Before" lines={hunk.before} />
          <DiffPane label="After" lines={hunk.after} />
        </section>
      ))}
      {before.length > 0 && !before.endsWith('\n') && (
        <p className="text-xs text-fg-muted">Before: no newline at end of file.</p>
      )}
      {after.length > 0 && !after.endsWith('\n') && (
        <p className="text-xs text-fg-muted">After: no newline at end of file.</p>
      )}
    </div>
  );
}

function DiffPane({ label, lines }: { label: 'Before' | 'After'; lines: DiffLine[] }) {
  const kind = label === 'Before' ? 'removed' : 'added';
  return (
    <div className="phone-diff-pane" aria-label={label}>
      <p className="px-2 py-1 text-xs text-fg-muted">
        {label}
        {lines.length > 0 && ` · ${lines[0]!.number}–${lines.at(-1)!.number}`}
      </p>
      {lines.length === 0 ? (
        <p className="px-2 py-1 text-xs text-fg-muted">No lines</p>
      ) : (
        <div className="phone-diff-code" tabIndex={0}>
          {lines.map((line) => (
            <div
              key={line.number}
              className="phone-diff-line"
              data-change={line.changed ? kind : undefined}
            >
              <span className="phone-diff-number" aria-hidden="true">
                {line.number}
              </span>
              <span className="phone-diff-sign" aria-hidden="true">
                {line.changed ? (label === 'Before' ? '−' : '+') : ' '}
              </span>
              <code>
                {line.spans.map((span, index) =>
                  span.changed ? <mark key={index}>{span.text}</mark> : span.text,
                )}
                {'\n'}
              </code>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
