import { useState } from 'react';
import { Disclosure } from '../../../../components/ui/disclosure';
import type { ComparedDiskConflict } from '../../../editor/conflicts/conflict-store';

/** Review the captured dependencies as well as the edited file; never fetch a newer revision here. */
export function ConflictSources({ conflict }: { conflict: ComparedDiskConflict }) {
  const [selected, setSelected] = useState<{ kind: 'file' | 'contract'; path: string } | null>(
    null,
  );
  const current = conflict.baseRevision;
  const before = conflict.previousRevision;
  if (!current || !conflict.captured) return null;
  const files = [...new Set([...Object.keys(before?.files ?? {}), ...Object.keys(current.files)])]
    .filter((path) => before?.files[path] !== current.files[path])
    .sort();
  const contracts = [
    ...new Set([...Object.keys(before?.components ?? {}), ...Object.keys(current.components)]),
  ]
    .filter((node) => before?.components[node] !== current.components[node])
    .sort();
  return (
    <Disclosure
      className="shrink-0 px-3 py-2 text-xs text-fg-secondary"
      summary={`Huddle source review · ${files.length} ${files.length === 1 ? 'file' : 'files'} · ${contracts.length} ${contracts.length === 1 ? 'contract' : 'contracts'}`}
    >
      {!before && (
        <p className="py-2">
          This draft has no captured baseline. Review the current source before saving.
        </p>
      )}
      <p className="py-2">
        Saving uses this captured revision. Further changes require another review.
      </p>
      <div className="flex max-h-32 flex-wrap gap-2 overflow-auto">
        {files.map((path) => (
          <button
            key={path}
            type="button"
            className="rounded px-2 py-1 hover:bg-elevated"
            onClick={() => setSelected({ kind: 'file', path })}
          >
            {path}
            {current.files[path] ? '' : ' · removed'}
          </button>
        ))}
      </div>
      <div className="flex max-h-32 flex-wrap gap-2 overflow-auto">
        {contracts.map((path) => (
          <button
            key={path}
            type="button"
            className="rounded px-2 py-1 hover:bg-elevated"
            onClick={() => setSelected({ kind: 'contract', path })}
          >
            {path} · contract{current.components[path] ? '' : ' · removed'}
          </button>
        ))}
      </div>
      {selected && (
        <div className="py-2">
          <p>
            {selected.path} · captured {selected.kind}
          </p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap p-2 text-fg">
            {(selected.kind === 'file'
              ? conflict.captured.files[selected.path]
              : JSON.stringify(conflict.captured.document.components[selected.path], null, 2)) ??
              'Removed from this capture.'}
          </pre>
        </div>
      )}
    </Disclosure>
  );
}
