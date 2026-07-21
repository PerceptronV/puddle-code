import { useMemo, useState } from 'react';
import { CornerDownLeft, Copy, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ScratchpadEntry } from '@puddle/shared';
import { AgentIcon } from '../../components/agent-icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import {
  useAgents,
  useCreateScratchpad,
  useDeleteScratchpad,
  usePatchScratchpad,
  useScratchpad,
} from '../../lib/queries';
import { cn } from '../../lib/utils';
import { ScratchpadEditor, type ScratchpadDraft } from './ScratchpadEditor';

/**
 * The Scratchpad panel (SPEC §11): the right sidebar's second view, a bank of
 * reusable prompts and notes for the current profile. Shows profile-scoped
 * entries plus the current project's own, newest on top, drag-reorderable, and
 * filterable by tag or agent type. Each entry can be inserted into the focused
 * terminal (bracketed paste, no submit), copied, edited, or deleted.
 */
export function ScratchpadPanel({
  profileId,
  projectId,
  onInsert,
}: {
  profileId: string | null;
  projectId: string;
  /** Paste an entry's body into the focused terminal without submitting. */
  onInsert: (text: string) => void;
}) {
  const entries = useScratchpad(profileId ?? undefined, projectId).data ?? [];
  const agents = useAgents().data ?? [];
  const create = useCreateScratchpad();
  const patch = usePatchScratchpad();
  const remove = useDeleteScratchpad();

  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [filterAgent, setFilterAgent] = useState<string | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [localOrder, setLocalOrder] = useState<ScratchpadEntry[] | null>(null);

  const allTags = useMemo(
    () => [...new Set(entries.flatMap((e) => e.tags))].sort((a, b) => a.localeCompare(b)),
    [entries],
  );
  const allAgents = useMemo(
    () => [...new Set(entries.map((e) => e.agent_type).filter((a): a is string => a !== null))],
    [entries],
  );
  const filterActive = filterTag !== null || filterAgent !== null;

  const visible = entries.filter(
    (e) =>
      (filterTag === null || e.tags.includes(filterTag)) &&
      (filterAgent === null || e.agent_type === filterAgent),
  );
  // Reordering operates on the full list only (ambiguous under a filter), so the
  // rendered list is the live filter result, or the in-drag local order.
  const rows = filterActive ? visible : (localOrder ?? entries);

  const saveNew = (draft: ScratchpadDraft) => {
    if (!profileId) return;
    create.mutate({
      profile_id: profileId,
      scope: draft.scope,
      project_id: draft.scope === 'project' ? projectId : undefined,
      title: draft.title ?? undefined,
      body: draft.body,
      tags: draft.tags,
      agent_type: draft.agent_type ?? undefined,
    });
    setEditing(null);
  };

  const saveEdit = (id: number, draft: ScratchpadDraft) => {
    patch.mutate({
      id,
      scope: draft.scope,
      project_id: draft.scope === 'project' ? projectId : null,
      title: draft.title,
      body: draft.body,
      tags: draft.tags,
      agent_type: draft.agent_type,
    });
    setEditing(null);
  };

  const moveLocal = (dragId: number, overId: number) => {
    const base = localOrder ?? entries;
    const from = base.findIndex((e) => e.id === dragId);
    const to = base.findIndex((e) => e.id === overId);
    if (from === -1 || to === -1 || from === to) return;
    const next = base.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    setLocalOrder(next);
  };

  const commitReorder = () => {
    const id = dragging;
    const order = localOrder;
    setDragging(null);
    setLocalOrder(null);
    if (id === null || !order) return; // released without moving
    const i = order.findIndex((e) => e.id === id);
    if (i === -1) return;
    const prev = order[i - 1];
    const next = order[i + 1];
    // Fractional midpoint of the new neighbours (smaller = top); ends step by 1.
    const position = !prev
      ? (next ? next.position : 0) - 1
      : !next
        ? prev.position + 1
        : (prev.position + next.position) / 2;
    patch.mutate({ id, position });
  };

  const copy = (entry: ScratchpadEntry) => {
    void navigator.clipboard?.writeText(entry.body);
    toast.success('Copied to clipboard');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-2">
        <span className="text-2xs font-medium uppercase tracking-wide text-fg-gold">
          Scratchpad
        </span>
        <button
          type="button"
          onClick={() => setEditing(editing === 'new' ? null : 'new')}
          className="ml-auto flex items-center rounded-md p-1 text-fg-gold transition-colors hover:bg-elevated hover:text-fg"
        >
          <Plus className="size-4" />
          <span className="sr-only">New entry</span>
        </button>
      </div>

      {/* Filters: tag chips and agent toggles present in the current list. */}
      {(allTags.length > 0 || allAgents.length > 0) && (
        <div className="flex flex-wrap items-center gap-1 px-3 pb-2">
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => setFilterTag((cur) => (cur === tag ? null : tag))}
              className={cn(
                'rounded-full px-2 py-0.5 text-2xs transition-colors',
                filterTag === tag
                  ? 'bg-action text-action-ink'
                  : 'bg-elevated text-fg-secondary hover:text-fg',
              )}
            >
              {tag}
            </button>
          ))}
          {allAgents.map((a) => (
            <button
              key={a}
              type="button"
              aria-pressed={filterAgent === a}
              onClick={() => setFilterAgent((cur) => (cur === a ? null : a))}
              className={cn(
                'rounded-md p-1 transition-colors',
                filterAgent === a ? 'bg-action text-action-ink' : 'text-fg-gold hover:bg-elevated',
              )}
            >
              <AgentIcon type={a} className="size-3.5" />
            </button>
          ))}
        </div>
      )}

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto pb-2">
        {editing === 'new' && (
          <ScratchpadEditor
            defaultScope="project"
            agents={agents}
            onSave={saveNew}
            onCancel={() => setEditing(null)}
          />
        )}
        {rows.length === 0 && editing !== 'new' && (
          <p className="px-3 py-3 text-xs text-fg-muted">
            {filterActive ? 'Nothing matches this filter.' : 'No entries yet — press + to add one.'}
          </p>
        )}
        <ul className="flex flex-col">
          {rows.map((entry) =>
            editing === entry.id ? (
              <li key={entry.id}>
                <ScratchpadEditor
                  initial={entry}
                  defaultScope="project"
                  agents={agents}
                  onSave={(draft) => saveEdit(entry.id, draft)}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : (
              <li
                key={entry.id}
                draggable={!filterActive}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  setDragging(entry.id);
                }}
                onDragOver={(e) => {
                  if (dragging === null) return;
                  e.preventDefault();
                  if (dragging !== entry.id) moveLocal(dragging, entry.id);
                }}
                onDragEnd={commitReorder}
                className={cn('transition-opacity', dragging === entry.id && 'opacity-50')}
              >
                <ScratchpadRow
                  entry={entry}
                  reorderable={!filterActive}
                  onInsert={() => onInsert(entry.body)}
                  onCopy={() => copy(entry)}
                  onEdit={() => setEditing(entry.id)}
                  onDelete={() => remove.mutate(entry.id)}
                />
              </li>
            ),
          )}
        </ul>
      </div>
    </div>
  );
}

/** One entry row: title/first-line, scope + tag chips, agent mark, body preview, hover actions. */
function ScratchpadRow({
  entry,
  reorderable,
  onInsert,
  onCopy,
  onEdit,
  onDelete,
}: {
  entry: ScratchpadEntry;
  reorderable: boolean;
  onInsert: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const heading = entry.title || entry.body.split('\n', 1)[0];
  return (
    <div className="group flex gap-1.5 px-3 py-1.5 transition-colors hover:bg-elevated">
      {reorderable && (
        <GripVertical className="mt-0.5 size-3.5 shrink-0 cursor-grab text-fg-muted opacity-0 transition-opacity group-hover:opacity-100" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-fg">{heading}</span>
          <span className="shrink-0 text-2xs uppercase tracking-wide text-fg-muted">
            {entry.scope === 'profile' ? 'Profile' : 'Project'}
          </span>
          {entry.agent_type && (
            <AgentIcon type={entry.agent_type} className="size-3 text-fg-gold" />
          )}
        </div>
        {entry.title && (
          <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap font-mono text-2xs text-fg-muted">
            {entry.body}
          </p>
        )}
        {entry.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {entry.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-elevated px-1.5 text-2xs text-fg-secondary"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
        {/* Actions: reserve no height until hover, then a compact icon row. */}
        <div className="mt-1 hidden items-center gap-1 group-hover:flex">
          <RowAction
            icon={CornerDownLeft}
            label="Insert into focused terminal"
            onClick={onInsert}
          />
          <RowAction icon={Copy} label="Copy" onClick={onCopy} />
          <RowAction icon={Pencil} label="Edit" onClick={onEdit} />
          <RowAction icon={Trash2} label="Delete" onClick={onDelete} />
        </div>
      </div>
    </div>
  );
}

function RowAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="rounded-md p-1 text-fg-gold transition-colors hover:bg-surface hover:text-fg"
        >
          <Icon className="size-3.5" />
          <span className="sr-only">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
