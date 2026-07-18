import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Archive,
  ArchiveRestore,
  ExternalLink,
  MoreHorizontal,
  Pencil,
  Play,
  Square,
  SquareTerminal,
  UserRoundCog,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Account, Session } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '../../components/ui/context-menu';
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
import { editorDeepLink, editorLinkHost } from '../../lib/editor-links';
import {
  useAccounts,
  useArchiveSession,
  useCreateSession,
  useMigrateSession,
  useRenameSession,
  useSessionAction,
  useUnarchiveSession,
} from '../../lib/queries';
import { useCurrentProfileId } from '../profile/profile-store';

const LIVE: Session['status'][] = ['starting', 'running', 'waiting_input'];
const RESUMABLE: Session['status'][] = ['exited', 'interrupted'];

/**
 * The shared lifecycle-menu model for one session: which actions apply, the
 * handlers behind them, and the confirmation dialogs. Rendered by both the
 * hover ellipsis (`SessionActionsEllipsis`) and the right-click menu
 * (`SessionContextMenu`) so every surface offers the same actions.
 */
export interface SessionMenu {
  session: Session;
  resumable: boolean;
  live: boolean;
  archived: boolean;
  canMigrate: boolean;
  sameAgent: Account[];
  resume: () => void;
  openKill: () => void;
  openRename: () => void;
  /** Spawn a terminal session sharing this session's worktree directory. */
  openTerminal: () => void;
  /** Archive straight away — no confirmation (SPEC §4: nothing is destroyed). */
  archive: () => void;
  unarchive: () => void;
  setMigrateTo: (a: Account) => void;
}

/** Menu primitives shared by the dropdown and context-menu renderers. */
interface MenuKit {
  Item: React.ElementType;
  Separator: React.ElementType;
  Sub: React.ElementType;
  SubTrigger: React.ElementType;
  SubContent: React.ElementType;
}

const dropdownKit: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

const contextKit: MenuKit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};

/** Owns the mutations, dialog state, and confirmation dialogs for a session. */
export function useSessionMenu(
  session: Session,
  onArchived?: (id: string) => void,
): { menu: SessionMenu; dialogs: ReactNode } {
  const resume = useSessionAction('resume');
  const kill = useSessionAction('kill');
  const archive = useArchiveSession();
  const unarchive = useUnarchiveSession();
  const rename = useRenameSession();
  const migrate = useMigrateSession();
  const createTerminal = useCreateSession();
  const navigate = useNavigate();
  const profileId = useCurrentProfileId();
  const accounts = useAccounts(profileId ?? undefined);
  const [confirm, setConfirm] = useState<'kill' | null>(null);
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

  const menu: SessionMenu = {
    session,
    resumable: RESUMABLE.includes(session.status),
    live: LIVE.includes(session.status),
    archived: session.status === 'archived',
    canMigrate,
    sameAgent,
    resume: () => resume.mutate(session.id, { onError: (e) => toast.error(e.message) }),
    openKill: () => setConfirm('kill'),
    // A plain shell in THIS session's working directory (SPEC §4: a terminal
    // session joining an existing worktree) — for git surgery, running tests,
    // or poking at files beside the agent. Lands in the new terminal.
    openTerminal: () =>
      createTerminal.mutate(
        {
          project_id: session.project_id,
          kind: 'terminal',
          separate_branch: false,
          separate_worktree: false,
          join_worktree: session.worktree_path,
        },
        {
          onSuccess: (t) => void navigate(`/project/${t.project_id}/session/${t.id}`),
          onError: (e) => toast.error(e.message),
        },
      ),
    openRename: () => {
      setNewTitle(session.title ?? ''); // seed from the current override, not the default
      setRenaming(true);
    },
    // Archiving keeps everything (worktree, branch, conversation), so it needs no
    // confirmation — one click hides it (SPEC §4). onArchived lets the caller drop
    // the now-archived tab from the open panes.
    archive: () =>
      archive.mutate(session.id, {
        onSuccess: () => onArchived?.(session.id),
        onError: (e) => toast.error(e.message),
      }),
    unarchive: () => unarchive.mutate(session.id, { onError: (e) => toast.error(e.message) }),
    setMigrateTo,
  };

  const dialogs = (
    <>
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (open) return;
          setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Kill this session?</DialogTitle>
            <DialogDescription>
              The agent process stops (SIGTERM, then SIGKILL). The conversation stays resumable.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
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
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
            <DialogDescription>
              Leave it empty to use the agent&rsquo;s own session name.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              // An empty title clears the override; the daemon reverts the name
              // to the agent's own name (then the id prefix).
              rename.mutate(
                { sessionId: session.id, title: newTitle.trim() },
                {
                  onSuccess: () => setRenaming(false),
                  onError: (err) => toast.error(err.message),
                },
              );
            }}
          >
            <Input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder={session.agent_title ?? session.osc_title ?? session.id.slice(0, 8)}
              autoFocus
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={rename.isPending}>
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

  return { menu, dialogs };
}

/** The action items, rendered with either the dropdown or context-menu kit. */
function SessionMenuItems({ kit, menu }: { kit: MenuKit; menu: SessionMenu }) {
  const { Item, Separator, Sub, SubTrigger, SubContent } = kit;
  const { session } = menu;
  return (
    <>
      {menu.resumable && !session.worktree_missing && (
        <Item onSelect={menu.resume}>
          <Play /> Resume
        </Item>
      )}
      {menu.live && (
        <Item onSelect={menu.openKill}>
          <Square /> Kill
        </Item>
      )}
      <Item onSelect={menu.openRename}>
        <Pencil /> Rename
      </Item>
      {menu.canMigrate && (
        <Sub>
          <SubTrigger>
            <UserRoundCog /> Move to account…
          </SubTrigger>
          <SubContent>
            {menu.sameAgent.map((a) => {
              const current = a.id === session.account_id;
              return (
                <Item key={a.id} disabled={current} onSelect={() => menu.setMigrateTo(a)}>
                  {a.label}
                  {current && <span className="ml-auto text-fg-muted">current</span>}
                </Item>
              );
            })}
          </SubContent>
        </Sub>
      )}
      {!session.worktree_missing && (
        <>
          <Separator />
          <Item onSelect={menu.openTerminal}>
            <SquareTerminal /> Open terminal in worktree
          </Item>
          {/* Deep links, not regular navigation — window.location.href hands the
              URL to the OS/editor and leaves the tab in place. */}
          <Item
            onSelect={() => {
              window.location.href = editorDeepLink(
                'vscode',
                session.worktree_path,
                editorLinkHost(),
              );
            }}
          >
            <ExternalLink /> Open in VS Code
          </Item>
          <Item
            onSelect={() => {
              window.location.href = editorDeepLink(
                'cursor',
                session.worktree_path,
                editorLinkHost(),
              );
            }}
          >
            <ExternalLink /> Open in Cursor
          </Item>
        </>
      )}
      {menu.resumable && (
        <>
          <Separator />
          <Item onSelect={menu.archive}>
            <Archive /> Archive
          </Item>
        </>
      )}
      {menu.archived && (
        <>
          <Separator />
          <Item onSelect={menu.unarchive}>
            <ArchiveRestore /> Unarchive
          </Item>
        </>
      )}
    </>
  );
}

/** The hover ellipsis trigger — shares `menu` with the row's context menu. */
export function SessionActionsEllipsis({ menu }: { menu: SessionMenu }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-6" onClick={(e) => e.preventDefault()}>
          <MoreHorizontal />
          <span className="sr-only">Session actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <SessionMenuItems kit={dropdownKit} menu={menu} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Wraps a session surface (sidebar row, top tab) so right-clicking it opens the
 * same lifecycle menu as the ellipsis. `children` may be a render function that
 * receives the shared `menu` (so a row can also mount `SessionActionsEllipsis`
 * over the same model); the confirmation dialogs are rendered once here.
 */
export function SessionContextMenu({
  session,
  onArchived,
  children,
}: {
  session: Session;
  onArchived?: (id: string) => void;
  children: React.ReactElement | ((menu: SessionMenu) => React.ReactElement);
}) {
  const { menu, dialogs } = useSessionMenu(session, onArchived);
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {typeof children === 'function' ? children(menu) : children}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <SessionMenuItems kit={contextKit} menu={menu} />
        </ContextMenuContent>
      </ContextMenu>
      {dialogs}
    </>
  );
}

/** For surfaces that need the menu but compose their own trigger (e.g. the
 *  tooltip-wrapped collapsed dot): renders the context-menu content + dialogs. */
export function SessionContextMenuBody({ menu }: { menu: SessionMenu }) {
  return (
    <ContextMenuContent>
      <SessionMenuItems kit={contextKit} menu={menu} />
    </ContextMenuContent>
  );
}
