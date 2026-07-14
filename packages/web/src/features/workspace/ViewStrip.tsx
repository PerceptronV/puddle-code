import { useNavigate } from 'react-router';
import { PanelLeft } from 'lucide-react';
import { cn } from '../../lib/utils';

export type SessionView = 'terminal' | 'diff' | 'history';

/**
 * Per-session view switcher (SPEC §8): Terminal · Diff · History for the active
 * session, plus the file-explorer toggle adopted onto the right edge. The
 * active view is marked by a fill shift (`bg-elevated`), never a border or
 * underline — HUMANS.md. Rendered only while a session is active.
 */
export function ViewStrip({
  projectId,
  sessionId,
  view,
  explorerOpen,
  onToggleExplorer,
}: {
  projectId: string;
  sessionId: string;
  view: SessionView;
  explorerOpen: boolean;
  onToggleExplorer: () => void;
}) {
  const navigate = useNavigate();
  const base = `/project/${projectId}/session/${sessionId}`;
  const items: { key: SessionView; label: string; to: string }[] = [
    { key: 'terminal', label: 'Terminal', to: base },
    { key: 'diff', label: 'Diff', to: `${base}/diff` },
    { key: 'history', label: 'History', to: `${base}/history` },
  ];

  return (
    <div className="flex items-stretch bg-surface px-1">
      <div className="flex items-center gap-0.5 py-1">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-current={view === item.key ? 'page' : undefined}
            onClick={() => void navigate(item.to)}
            className={cn(
              'rounded-md px-2.5 py-1 font-mono text-xs transition-colors',
              view === item.key
                ? 'bg-elevated text-fg'
                : 'text-fg-secondary hover:bg-elevated hover:text-fg',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-pressed={explorerOpen}
        title={explorerOpen ? 'Hide file explorer' : 'Show file explorer'}
        onClick={onToggleExplorer}
        className="ml-auto flex items-center px-2 text-fg-muted transition-colors hover:bg-elevated hover:text-fg"
      >
        <PanelLeft className="size-4" />
        <span className="sr-only">Toggle file explorer</span>
      </button>
    </div>
  );
}
