import { useState } from 'react';
import { Archive, MoreHorizontal, Pencil, Play, Square } from 'lucide-react';
import { toast } from 'sonner';
import type { Session } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Input } from '../../components/ui/input';
import { ApiError } from '../../lib/api';
import { useArchiveSession, useRenameSession, useSessionAction } from '../../lib/queries';

const LIVE: Session['status'][] = ['starting', 'running', 'waiting_input'];
const RESUMABLE: Session['status'][] = ['exited', 'interrupted'];

/** Per-row lifecycle menu: resume, kill, archive (with dirty-worktree force), rename. */
export function SessionActions({
  session,
  onArchived,
}: {
  session: Session;
  onArchived?: (id: string) => void;
}) {
  const resume = useSessionAction('resume');
  const kill = useSessionAction('kill');
  const archive = useArchiveSession();
  const rename = useRenameSession();
  const [confirm, setConfirm] = useState<'kill' | 'archive' | 'archive-force' | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newTitle, setNewTitle] = useState(session.title ?? '');

  const doArchive = (force: boolean) => {
    archive.mutate(
      { sessionId: session.id, force },
      {
        onSuccess: () => {
          setConfirm(null);
          onArchived?.(session.id);
        },
        onError: (e) => {
          if (e instanceof ApiError && e.code === 'worktree_dirty' && !force) {
            setConfirm('archive-force');
          } else {
            setConfirm(null);
            toast.error(e.message);
          }
        },
      },
    );
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={(e) => e.preventDefault()}
          >
            <MoreHorizontal />
            <span className="sr-only">Session actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {RESUMABLE.includes(session.status) && !session.worktree_missing && (
            <DropdownMenuItem
              onSelect={() => resume.mutate(session.id, { onError: (e) => toast.error(e.message) })}
            >
              <Play /> Resume
            </DropdownMenuItem>
          )}
          {LIVE.includes(session.status) && (
            <DropdownMenuItem onSelect={() => setConfirm('kill')}>
              <Square /> Kill
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <Pencil /> Rename
          </DropdownMenuItem>
          {RESUMABLE.includes(session.status) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setConfirm('archive')}>
                <Archive /> Archive
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm === 'kill' && 'Kill this session?'}
              {confirm === 'archive' && 'Archive this session?'}
              {confirm === 'archive-force' && 'Worktree has uncommitted changes'}
            </DialogTitle>
            <DialogDescription>
              {confirm === 'kill' &&
                'The agent process stops (SIGTERM, then SIGKILL). The conversation stays resumable.'}
              {confirm === 'archive' &&
                `Removes the worktree directory. The branch ${session.branch} and the terminal logs are kept.`}
              {confirm === 'archive-force' &&
                'Archiving now discards uncommitted changes in the worktree. Committed work on the branch survives.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            {confirm === 'kill' && (
              <Button
                variant="danger"
                disabled={kill.isPending}
                onClick={() =>
                  kill.mutate(session.id, {
                    onSuccess: () => setConfirm(null),
                    onError: (e) => {
                      setConfirm(null);
                      toast.error(e.message);
                    },
                  })
                }
              >
                Kill session
              </Button>
            )}
            {confirm === 'archive' && (
              <Button
                variant="danger"
                disabled={archive.isPending}
                onClick={() => doArchive(false)}
              >
                Archive
              </Button>
            )}
            {confirm === 'archive-force' && (
              <Button variant="danger" disabled={archive.isPending} onClick={() => doArchive(true)}>
                Discard changes and archive
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newTitle.trim()) return;
              rename.mutate(
                { sessionId: session.id, title: newTitle.trim() },
                {
                  onSuccess: () => setRenaming(false),
                  onError: (err) => toast.error(err.message),
                },
              );
            }}
          >
            <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} autoFocus />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!newTitle.trim() || rename.isPending}>
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
