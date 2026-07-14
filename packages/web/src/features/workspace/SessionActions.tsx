import { useState } from 'react';
import {
  Archive,
  ExternalLink,
  MoreHorizontal,
  Pencil,
  Play,
  Square,
  UserRoundCog,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Account, Session } from '@puddle/shared';
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Switch } from '../../components/ui/switch';
import { ApiError } from '../../lib/api';
import { editorDeepLink, editorLinkHost } from '../../lib/editor-links';
import {
  useAccounts,
  useArchiveSession,
  useMigrateSession,
  useRenameSession,
  useSessionAction,
} from '../../lib/queries';
import { useCurrentProfileId } from '../profile/profile-store';

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
  const migrate = useMigrateSession();
  const profileId = useCurrentProfileId();
  const accounts = useAccounts(profileId ?? undefined);
  const [confirm, setConfirm] = useState<'kill' | 'archive' | 'archive-force' | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newTitle, setNewTitle] = useState(session.title ?? '');
  const [migrateTo, setMigrateTo] = useState<Account | null>(null);

  // Migration targets: accounts of the same agent on this profile (SPEC §5).
  // The current account is shown but disabled; a session with no other same-
  // agent account has no target, so the whole submenu is hidden.
  const sameAgent = (accounts.data ?? []).filter((a) => a.agent_type === session.agent_type);
  const canMigrate =
    !session.worktree_missing &&
    session.status !== 'archived' &&
    sameAgent.some((a) => a.id !== session.account_id);

  const doArchive = (force: boolean) => {
    archive.mutate(
      { sessionId: session.id, force, deleteBranch },
      {
        onSuccess: () => {
          setConfirm(null);
          setDeleteBranch(false);
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
          {canMigrate && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <UserRoundCog /> Move to account…
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {sameAgent.map((a) => {
                  const current = a.id === session.account_id;
                  return (
                    <DropdownMenuItem
                      key={a.id}
                      disabled={current}
                      onSelect={() => setMigrateTo(a)}
                    >
                      {a.label}
                      {current && <span className="ml-auto text-fg-muted">current</span>}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {!session.worktree_missing && (
            <>
              <DropdownMenuSeparator />
              {/* Deep links, not regular navigation — window.location.href hands
                  the URL to the OS/editor and leaves the tab in place, unlike
                  window.open (which pops an unwanted blank tab for a custom
                  scheme handler). */}
              <DropdownMenuItem
                onSelect={() => {
                  window.location.href = editorDeepLink(
                    'vscode',
                    session.worktree_path,
                    editorLinkHost(),
                  );
                }}
              >
                <ExternalLink /> Open in VS Code
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  window.location.href = editorDeepLink(
                    'cursor',
                    session.worktree_path,
                    editorLinkHost(),
                  );
                }}
              >
                <ExternalLink /> Open in Cursor
              </DropdownMenuItem>
            </>
          )}
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

      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (open) return;
          setConfirm(null);
          setDeleteBranch(false);
        }}
      >
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
                (session.separate_branch
                  ? `Removes the worktree directory. The branch ${session.branch} and the terminal logs are kept.`
                  : `The shared worktree on ${session.branch} is removed once its last session archives. The branch and the terminal logs are kept.`)}
              {confirm === 'archive-force' &&
                'Archiving now discards uncommitted changes in the worktree. Committed work on the branch survives.'}
            </DialogDescription>
          </DialogHeader>
          {(confirm === 'archive' || confirm === 'archive-force') && session.separate_branch && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Switch
                  id="delete-branch"
                  checked={deleteBranch}
                  onCheckedChange={setDeleteBranch}
                />
                <Label htmlFor="delete-branch">
                  Also delete the branch <span className="font-mono">{session.branch}</span>
                </Label>
              </div>
              {deleteBranch && (
                <p className="text-xs text-danger">
                  Anything on it that was never pushed is gone for good.
                </p>
              )}
            </div>
          )}
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

      <Dialog open={migrateTo !== null} onOpenChange={(open) => !open && setMigrateTo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move this session to {migrateTo?.label}?</DialogTitle>
            <DialogDescription>
              The conversation continues under that account&rsquo;s credentials. If the session is
              running it is stopped first, then resumed on the new account.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMigrateTo(null)}>
              Cancel
            </Button>
            <Button
              disabled={migrate.isPending}
              onClick={() => {
                if (!migrateTo) return;
                migrate.mutate(
                  { sessionId: session.id, accountId: migrateTo.id },
                  {
                    onSuccess: () => {
                      setMigrateTo(null);
                      toast.success(`Moved to ${migrateTo.label}`);
                    },
                    onError: (e) => {
                      setMigrateTo(null);
                      toast.error(e.message);
                    },
                  },
                );
              }}
            >
              Move session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
