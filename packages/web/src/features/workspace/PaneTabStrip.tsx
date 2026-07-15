import { X } from 'lucide-react';
import type { LayoutLeaf, Session, TabRef } from '@puddle/shared';
import { sessionDisplayName } from '../../lib/session-display';
import { cn } from '../../lib/utils';
import { StatusDot } from '../status/StatusDot';
import { editorTabLabel } from '../editor/buffer-logic';
import { tabKind, type EditorTab } from '../editor/editor-tabs';
import { LazyEditorTabClose } from '../editor/lazy-editor-parts';
import { SessionContextMenu } from './SessionActions';
import { tabRefKey } from './layout-tree';

const TAB_CLASS =
  'group flex min-w-0 max-w-52 cursor-pointer items-center gap-1.5 rounded-t-md px-2.5 text-xs transition-colors';

/**
 * A tiling pane's tab strip (SPEC §8) — one unified strip over BOTH terminal and
 * editor tabs (merging the old `TabStrip` + `EditorTabStrip`). Terminals show a
 * status dot + display name and the session lifecycle menu; editors show a
 * disambiguated label and a dirty-aware close (behind the lazy editor chunk).
 */
export function PaneTabStrip({
  leaf,
  sessions,
  onActivate,
  onClose,
  onArchived,
}: {
  leaf: LayoutLeaf;
  sessions: Session[];
  onActivate: (ref: TabRef) => void;
  onClose: (ref: TabRef) => void;
  onArchived: (session: string) => void;
}) {
  const branches = new Map(sessions.map((s) => [s.id, s.branch]));
  const editorTabs = leaf.tabs.flatMap((t) => (t.type === 'editor' ? [t.tab] : []));

  const labelFor = (tab: EditorTab): string => {
    const base = editorTabLabel(tab.path, tab.session, editorTabs, branches);
    if (tabKind(tab) === 'diff') return `${base} (diff)`;
    if (tabKind(tab) === 'commit') return `${base} @${(tab.sha ?? '').slice(0, 7)}`;
    return base;
  };

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-0.5 overflow-x-auto bg-surface px-1 pt-1">
      {leaf.tabs.map((ref) => {
        const key = tabRefKey(ref);
        const active = key === leaf.activeKey;
        const cls = cn(
          TAB_CLASS,
          active ? 'bg-ground text-fg' : 'text-fg-secondary hover:bg-elevated',
        );

        if (ref.type === 'terminal') {
          const session = sessions.find((s) => s.id === ref.session);
          const inner = (
            <div onClick={() => onActivate(ref)} className={cls}>
              {session && <StatusDot status={session.status} kind={session.kind} />}
              <span className="truncate font-mono">
                {session ? sessionDisplayName(session) : ref.session.slice(0, 8)}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(ref);
                }}
                className="rounded-sm p-0.5 text-fg-muted opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
                aria-label="Close tab"
              >
                <X className="size-3" />
              </button>
            </div>
          );
          return session ? (
            <SessionContextMenu
              key={key}
              session={session}
              onArchived={() => onArchived(ref.session)}
            >
              {inner}
            </SessionContextMenu>
          ) : (
            <div key={key}>{inner}</div>
          );
        }

        const label = labelFor(ref.tab);
        return (
          <div key={key} onClick={() => onActivate(ref)} className={cls}>
            <span className="truncate font-mono">{label}</span>
            <LazyEditorTabClose
              session={ref.tab.session}
              path={ref.tab.path}
              kind={tabKind(ref.tab)}
              label={label}
              onClose={() => onClose(ref)}
            />
          </div>
        );
      })}
    </div>
  );
}
