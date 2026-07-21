import { useState } from 'react';
import type { AgentType, ScratchpadEntry, ScratchpadScope } from '@puddle/shared';
import { AgentIcon } from '../../components/agent-icon';
import { Button } from '../../components/ui/button';
import { Input, Textarea } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import { cn } from '../../lib/utils';

export interface ScratchpadDraft {
  title: string | null;
  body: string;
  scope: ScratchpadScope;
  tags: string[];
  agent_type: string | null;
}

/**
 * Inline create/edit form for a Scratchpad entry (SPEC §11): a multi-line body,
 * an optional title, the project⇄profile scope, comma-separated tags, and an
 * optional agent association. No dialog (HUMANS.md) — it expands in place. The
 * body textarea stops keydown propagation so global shortcuts (⌘K) don't fire
 * while typing; ⌘↵ saves and Esc cancels.
 */
export function ScratchpadEditor({
  initial,
  defaultScope,
  agents,
  onSave,
  onCancel,
}: {
  initial?: ScratchpadEntry;
  defaultScope: ScratchpadScope;
  agents: AgentType[];
  onSave: (draft: ScratchpadDraft) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [scope, setScope] = useState<ScratchpadScope>(initial?.scope ?? defaultScope);
  const [tagsText, setTagsText] = useState((initial?.tags ?? []).join(', '));
  const [agentType, setAgentType] = useState<string | null>(initial?.agent_type ?? null);

  const save = () => {
    const trimmed = body.trim();
    if (!trimmed) return; // body is required
    onSave({
      title: title.trim() || null,
      body: trimmed,
      scope,
      tags: tagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      agent_type: agentType,
    });
  };

  return (
    <div className="flex flex-col gap-2 bg-elevated px-3 py-2">
      <Input
        value={title}
        placeholder="Title (optional)"
        spellCheck={false}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        className="h-7 text-xs"
      />
      <Textarea
        autoFocus
        value={body}
        placeholder="Prompt or note…"
        spellCheck={false}
        rows={4}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onCancel();
          else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
        }}
        className="resize-y font-mono text-xs"
      />
      <Input
        value={tagsText}
        placeholder="tags, comma, separated"
        spellCheck={false}
        onChange={(e) => setTagsText(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        className="h-7 text-xs"
      />
      <div className="flex items-center gap-2">
        {/* Scope: off = project (default), on = profile-wide. */}
        <label className="flex items-center gap-1.5 text-2xs text-fg-secondary">
          <Switch
            checked={scope === 'profile'}
            onCheckedChange={(on) => setScope(on ? 'profile' : 'project')}
          />
          Profile-wide
        </label>
        {/* Agent association: a row of brand toggles, plus a clear. */}
        <div className="ml-auto flex items-center gap-1">
          {agents.map((a) => (
            <button
              key={a.id}
              type="button"
              title={a.display_name}
              aria-pressed={agentType === a.id}
              onClick={() => setAgentType((cur) => (cur === a.id ? null : a.id))}
              className={cn(
                'rounded-md p-1 transition-colors',
                agentType === a.id
                  ? 'bg-surface text-fg'
                  : 'text-fg-gold hover:bg-surface hover:text-fg',
              )}
            >
              <AgentIcon type={a.id} className="size-3.5" />
              <span className="sr-only">{a.display_name}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!body.trim()} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
