import { useState, type KeyboardEvent, type ReactNode } from 'react';
import type { GitArea, GitChangeEntry, GitRepository } from '@puddle/shared';
import { ChevronDown, ChevronRight, Download, Minus, Plus, Send, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { useGitMutation } from '../../lib/worktree-queries';
import { cn } from '../../lib/utils';
import { gitDecoration } from '../explorer/git-decoration';

export interface SourceControlOpenOptions {
  preview?: boolean;
  root?: string;
  gitArea?: GitArea;
}

function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
          className="rounded-sm p-1 text-fg-muted transition-colors hover:bg-elevated hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ChangeGroup({
  title,
  entries,
  area,
  activePath,
  action,
  busy,
  onAction,
  onOpen,
}: {
  title: string;
  entries: GitChangeEntry[];
  area: GitArea;
  activePath: string | null;
  action: 'stage' | 'unstage';
  busy: boolean;
  onAction(paths: string[]): void;
  onOpen(path: string, opts?: SourceControlOpenOptions): void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (entries.length === 0) return null;
  const stage = action === 'stage';
  const pathsFor = (entry: GitChangeEntry) =>
    entry.old_path === null ? [entry.path] : [entry.path, entry.old_path];
  return (
    <div>
      <div className="group flex h-7 items-center gap-1 px-2">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-2xs font-medium uppercase tracking-wide text-fg-secondary transition-colors hover:text-fg"
        >
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          <span className="truncate">{title}</span>
          <span className="ml-1 text-fg-muted">{entries.length}</span>
        </button>
        <IconAction
          label={`${stage ? 'Stage' : 'Unstage'} all ${title.toLowerCase()}`}
          disabled={busy}
          onClick={() => onAction(entries.flatMap(pathsFor))}
        >
          {stage ? <Plus className="size-3.5" /> : <Minus className="size-3.5" />}
        </IconAction>
      </div>
      {!collapsed &&
        entries.map((entry) => {
          const decoration = gitDecoration(entry.status);
          return (
            <div
              key={`${entry.path}:${entry.old_path ?? ''}`}
              className={cn(
                'group flex items-center gap-1 px-2 transition-colors hover:bg-elevated',
                activePath === entry.path && 'bg-selection',
              )}
            >
              <button
                type="button"
                title={entry.path}
                onClick={() => onOpen(entry.path, { root: undefined, gitArea: area })}
                onDoubleClick={() =>
                  onOpen(entry.path, { preview: false, root: undefined, gitArea: area })
                }
                className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
              >
                <span
                  className={cn(
                    'w-3 shrink-0 text-center font-mono text-xs',
                    decoration.colourClass,
                  )}
                >
                  {decoration.letter}
                </span>
                <span className="truncate text-xs text-fg">{entry.path}</span>
              </button>
              <IconAction
                label={`${stage ? 'Stage' : 'Unstage'} ${entry.path}`}
                disabled={busy}
                onClick={() => onAction(pathsFor(entry))}
              >
                {stage ? <Plus className="size-3.5" /> : <Minus className="size-3.5" />}
              </IconAction>
            </div>
          );
        })}
    </div>
  );
}

function branchLabel(repository: GitRepository): string {
  if (repository.detached) return `Detached at ${repository.head?.slice(0, 8) ?? 'HEAD'}`;
  return repository.branch ?? 'Unborn branch';
}

/** One collapsible VS Code-style source-control repository group. */
export function SourceControlRepository({
  session,
  targetRoot,
  repository,
  selected,
  activePath,
  onSelect,
  onOpen,
}: {
  session: string;
  targetRoot?: string;
  repository: GitRepository;
  selected: boolean;
  activePath: string | null;
  onSelect(): void;
  onOpen(path: string, opts?: SourceControlOpenOptions): void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [message, setMessage] = useState('');
  const mutation = useGitMutation(session, targetRoot);
  const changes = [...repository.conflicts, ...repository.staged, ...repository.unstaged];
  const busy = mutation.isPending;

  const run = async (variables: Parameters<typeof mutation.mutateAsync>[0], success: string) => {
    try {
      await mutation.mutateAsync(variables);
      toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Git operation failed');
    }
  };
  const changePaths = (action: 'stage' | 'unstage', paths: string[]) => {
    void run(
      { action, repository: repository.root, paths },
      action === 'stage' ? 'Staged' : 'Unstaged',
    );
  };
  const commit = async () => {
    const trimmed = message.trim();
    if (!trimmed || busy) return;
    let stageAll = false;
    if (repository.staged.length === 0) {
      if (repository.conflicts.length > 0) {
        toast.error('Resolve and stage merge changes before committing');
        return;
      }
      if (repository.unstaged.length === 0) {
        toast.error('There are no changes to commit');
        return;
      }
      stageAll = window.confirm('Nothing is staged. Stage every change and commit it?');
      if (!stageAll) return;
    }
    try {
      await mutation.mutateAsync({
        action: 'commit',
        repository: repository.root,
        message: trimmed,
        stage_all: stageAll,
      });
      setMessage('');
      toast.success('Committed');
    } catch (error) {
      // Keep the message: a failed commit should be immediately retryable.
      toast.error(error instanceof Error ? error.message : 'Commit failed');
    }
  };
  const onMessageKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void commit();
    }
  };
  const openInRepository = (path: string, opts?: SourceControlOpenOptions) =>
    onOpen(path, { ...opts, root: repository.root });

  return (
    <section className={cn('py-0.5', selected && 'bg-surface/40')} onFocus={onSelect}>
      <div className="flex h-8 items-center gap-1 px-2">
        <button
          type="button"
          onClick={() => {
            onSelect();
            setCollapsed((value) => !value);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors hover:text-fg"
        >
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          <span className="truncate text-xs font-medium text-fg">{repository.name}</span>
          <span className="truncate text-2xs text-fg-muted">{repository.relative_path}</span>
          {changes.length > 0 && (
            <span className="ml-auto text-2xs text-fg-muted">{changes.length}</span>
          )}
        </button>
      </div>
      {!collapsed && (
        <div>
          <div className="flex min-h-7 items-center gap-2 px-3 text-2xs text-fg-muted">
            <span className="min-w-0 flex-1 truncate" title={branchLabel(repository)}>
              {branchLabel(repository)}
              {repository.upstream ? ` · ${repository.upstream}` : ''}
              {repository.ahead > 0 ? ` · ${repository.ahead} ahead` : ''}
              {repository.behind > 0 ? ` · ${repository.behind} behind` : ''}
            </span>
            {repository.initialised && repository.has_remote && (
              <>
                <IconAction
                  label="Fetch"
                  disabled={busy}
                  onClick={() =>
                    void run({ action: 'fetch', repository: repository.root }, 'Fetched')
                  }
                >
                  <Download className="size-3.5" />
                </IconAction>
                {repository.upstream && (
                  <IconAction
                    label="Pull"
                    disabled={busy}
                    onClick={() =>
                      void run({ action: 'pull', repository: repository.root }, 'Pulled')
                    }
                  >
                    <Upload className="size-3.5 rotate-180" />
                  </IconAction>
                )}
                {repository.branch && (
                  <IconAction
                    label={repository.upstream ? 'Push' : 'Publish branch'}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        {
                          action: 'push',
                          repository: repository.root,
                          set_upstream: !repository.upstream,
                        },
                        repository.upstream ? 'Pushed' : 'Branch published',
                      )
                    }
                  >
                    {repository.upstream ? (
                      <Send className="size-3.5" />
                    ) : (
                      <Upload className="size-3.5" />
                    )}
                  </IconAction>
                )}
              </>
            )}
          </div>

          {!repository.initialised ? (
            <div className="px-3 py-2 text-xs text-fg-muted">Submodule not initialised.</div>
          ) : (
            <>
              <div className="px-3 pb-1.5 pt-1">
                <textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={onMessageKeyDown}
                  rows={2}
                  placeholder="Commit message"
                  aria-label={`Commit message for ${repository.name}`}
                  className="w-full resize-none rounded-sm bg-elevated px-2 py-1.5 text-xs text-fg outline-none placeholder:text-fg-muted focus:ring-1 focus:ring-focus"
                />
                <button
                  type="button"
                  disabled={busy || message.trim().length === 0}
                  onClick={() => void commit()}
                  className="mt-1 w-full rounded-sm bg-action py-1 text-xs text-action-ink transition-colors hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Commit
                </button>
              </div>
              <ChangeGroup
                title="Merge Changes"
                entries={repository.conflicts}
                area="unstaged"
                activePath={activePath}
                action="stage"
                busy={busy}
                onAction={(paths) => changePaths('stage', paths)}
                onOpen={openInRepository}
              />
              <ChangeGroup
                title="Staged Changes"
                entries={repository.staged}
                area="staged"
                activePath={activePath}
                action="unstage"
                busy={busy}
                onAction={(paths) => changePaths('unstage', paths)}
                onOpen={openInRepository}
              />
              <ChangeGroup
                title="Changes"
                entries={repository.unstaged}
                area="unstaged"
                activePath={activePath}
                action="stage"
                busy={busy}
                onAction={(paths) => changePaths('stage', paths)}
                onOpen={openInRepository}
              />
              {changes.length === 0 && (
                <div className="px-3 py-2 text-xs text-fg-muted">No changes.</div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
