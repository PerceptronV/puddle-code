import { useEffect, useMemo, useState } from 'react';
import type { Session, SessionKind } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { HintInput } from '../../components/ui/hint-input';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { Switch } from '../../components/ui/switch';
import { cn } from '../../lib/utils';
import { openSettings } from '../../lib/hash-route';
import {
  useAccounts,
  useCreateSession,
  useProfileSettings,
  useRepoBranches,
  useRepoWorktrees,
  useRepos,
} from '../../lib/queries';
import { useCurrentProfileId } from '../profile/profile-store';

/**
 * Account → branch → directory (SPEC §4/§11). Two independent axes decide where
 * the session lands: **separate branch** (a fresh branch in its own worktree,
 * default on for agents / off for terminals) and, when that is off, **separate
 * directory** (its own working copy of the base branch, default on; turn it off
 * to share a directory — picking an existing one to drop into). The skip toggle
 * renders only when the profile gate is on and the chosen account opted in.
 */
export function NewSessionDialog({
  projectId,
  repoId,
  open,
  kind = 'agent',
  seedAccountId,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  repoId: number;
  open: boolean;
  /** 'terminal' opens the dialog in shell mode (no account); defaults to 'agent'. */
  kind?: SessionKind;
  /** Preselects the account picker (profile panel → session on this account). */
  seedAccountId?: number;
  onOpenChange: (open: boolean) => void;
  onCreated: (session: Session) => void;
}) {
  const isTerminal = kind === 'terminal';
  const profileId = useCurrentProfileId();
  const accounts = useAccounts(profileId ?? undefined);
  const settings = useProfileSettings(profileId ?? undefined);
  const repos = useRepos();
  const create = useCreateSession();

  const [accountId, setAccountId] = useState<string>('');
  const [baseBranch, setBaseBranch] = useState('');
  const [separateBranch, setSeparateBranch] = useState(true);
  const [separateWorktree, setSeparateWorktree] = useState(true);
  const [branch, setBranch] = useState('');
  const [joinWorktree, setJoinWorktree] = useState('');
  const [skip, setSkip] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repo = repos.data?.find((r) => r.id === repoId);
  const branches = useRepoBranches(open ? repoId : undefined);
  const worktrees = useRepoWorktrees(open ? repoId : undefined);
  const branchPreview = `leave blank for auto`;
  const account = accounts.data?.find((a) => String(a.id) === accountId);
  const gateOpen = settings.data?.allowSkipPermissions === true;
  const showSkipToggle = !isTerminal && gateOpen && account?.skip_permissions_default === true;

  const baseName = baseBranch.trim() || repo?.default_base_branch || '';

  // Every git worktree already checked out on the base branch — the clone
  // itself and any puddle worktree — so a shared session can drop into one.
  const joinable = useMemo(() => {
    return (worktrees.data?.worktrees ?? [])
      .filter((w) => w.branch === baseName)
      .map((w) => ({
        path: w.path,
        is_primary: w.is_primary,
        label: w.is_primary
          ? `${w.path.split('/').filter(Boolean).pop() ?? w.path} (clone)`
          : (w.path.split('/').filter(Boolean).pop() ?? w.path),
      }));
  }, [worktrees.data, baseName]);

  // Sharing a directory is only reachable with a shared branch and the separate-
  // directory toggle off; then a specific worktree may be joined. Default to the
  // clone when it is on the branch, else the first worktree.
  const sharingDirectory = !separateBranch && !separateWorktree;
  const defaultJoin = joinable.find((j) => j.is_primary)?.path ?? joinable[0]?.path ?? '';
  const effectiveJoin = joinWorktree || defaultJoin;

  const defaultAccount = useMemo(() => {
    const preferred = settings.data?.['default_account_id'];
    return (
      accounts.data?.find((a) => a.id === seedAccountId) ??
      accounts.data?.find((a) => typeof preferred === 'number' && a.id === preferred) ??
      accounts.data?.[0]
    );
  }, [accounts.data, settings.data, seedAccountId]);
  const effectiveAccountId = accountId || (defaultAccount ? String(defaultAccount.id) : '');

  useEffect(() => {
    if (open && seedAccountId !== undefined) setAccountId(String(seedAccountId));
  }, [open, seedAccountId]);

  // Reset the axes each time the dialog opens (or its mode changes). Agents:
  // separate branch on (own new branch). Terminals: separate branch off AND
  // separate directory off, so a terminal shares the base branch's directory
  // (the clone itself when that branch is checked out there).
  useEffect(() => {
    if (open) {
      setSeparateBranch(!isTerminal);
      setSeparateWorktree(!isTerminal);
      setJoinWorktree('');
    }
  }, [open, isTerminal]);

  const submit = () => {
    setError(null);
    create.mutate(
      {
        project_id: projectId,
        ...(isTerminal
          ? { kind: 'terminal' as const }
          : { account_id: Number(effectiveAccountId) }),
        ...(baseBranch.trim() ? { base_branch: baseBranch.trim() } : {}),
        separate_branch: separateBranch,
        ...(separateBranch && branch.trim() ? { branch: branch.trim() } : {}),
        // Only meaningful without a separate branch; a new branch always gets its own dir.
        ...(!separateBranch ? { separate_worktree: separateWorktree } : {}),
        ...(sharingDirectory && effectiveJoin ? { join_worktree: effectiveJoin } : {}),
        ...(showSkipToggle && skip ? { skip_permissions: true } : {}),
      },
      {
        onSuccess: (session) => {
          onOpenChange(false);
          setBranch('');
          setSkip(false);
          onCreated(session);
        },
        onError: (e) => setError(e.message),
      },
    );
  };

  const noun = isTerminal ? 'a shell' : 'an agent';
  const where = separateBranch
    ? `on a new branch off ${baseName || '…'}, in its own directory`
    : sharingDirectory
      ? `on ${baseName || '…'}, sharing an existing directory`
      : `on ${baseName || '…'}, in its own directory`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isTerminal ? 'New terminal' : 'New session'}</DialogTitle>
          <DialogDescription>
            {isTerminal ? 'Opens' : 'Spawns'} {noun} {where}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (isTerminal || effectiveAccountId) submit();
          }}
        >
          {!isTerminal && (
            <div className="flex flex-col gap-1.5">
              <Label>Account</Label>
              {accounts.data?.length === 0 ? (
                <p className="text-sm text-fg-secondary">
                  No accounts yet —{' '}
                  <button
                    type="button"
                    className="text-accent underline"
                    onClick={() => openSettings('accounts')}
                  >
                    add one in settings
                  </button>
                  .
                </p>
              ) : (
                <Select value={effectiveAccountId} onValueChange={setAccountId}>
                  <SelectTrigger>
                    <SelectValue placeholder="pick an account" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.data?.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        <span className="font-mono">
                          {a.agent_type}/{a.label}
                        </span>
                        {!a.logged_in && (
                          <span className="ml-2 text-2xs text-waiting">not logged in</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {/* Branch selection: base branch, and — only with a separate branch —
              the new branch name, side by side. */}
          <div className="flex gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Label htmlFor="base-branch">Base branch</Label>
              <HintInput
                id="base-branch"
                placeholder={repo?.default_base_branch ?? 'main'}
                value={baseBranch}
                onValueChange={setBaseBranch}
                hints={(branches.data?.branches ?? [])
                  .filter((b) => b.name.toLowerCase().includes(baseBranch.trim().toLowerCase()))
                  .slice(0, 20)
                  .map((b) => ({
                    value: b.name,
                    badge:
                      b.name === repo?.default_base_branch
                        ? 'default'
                        : b.is_session
                          ? `session: ${b.session_title ?? 'untitled'}`
                          : undefined,
                  }))}
                className="font-mono"
                hintsClassName="w-max min-w-full max-w-[36rem]"
              />
            </div>
            {separateBranch && (
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex items-baseline gap-2">
                  <Label htmlFor="session-branch">New branch</Label>
                  <span className="text-xs text-fg-muted">optional</span>
                </div>
                <Input
                  id="session-branch"
                  placeholder={branchPreview}
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  className="font-mono"
                />
              </div>
            )}
          </div>

          {/* Axis 1: separate branch. Axis 2: separate directory (forced on, and
              greyed, while a separate branch is used — a new branch is always
              its own directory). */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Switch
                id="separate-branch"
                checked={separateBranch}
                onCheckedChange={(v) => {
                  setSeparateBranch(v);
                  if (v) setSeparateWorktree(true);
                }}
              />
              <Label htmlFor="separate-branch">Use separate branch</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="separate-worktree"
                checked={separateBranch ? true : separateWorktree}
                disabled={separateBranch}
                onCheckedChange={setSeparateWorktree}
              />
              <Label htmlFor="separate-worktree" className={cn(separateBranch && 'text-fg-muted')}>
                Use separate directory
              </Label>
            </div>
          </div>

          {/* Sharing a directory: pick which existing one to join. */}
          {sharingDirectory && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="join-dir">Directory to join</Label>
              {joinable.length === 0 ? (
                <p className="text-xs text-fg-muted">
                  No existing directory on <span className="font-mono">{baseName || '…'}</span> — a
                  shared one will be created for later sessions to join.
                </p>
              ) : (
                <Select value={effectiveJoin} onValueChange={setJoinWorktree}>
                  <SelectTrigger id="join-dir">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {joinable.map((j) => (
                      <SelectItem key={j.path} value={j.path}>
                        <span className="truncate">{j.label}</span>
                        <span className="ml-2 truncate font-mono text-2xs text-fg-muted">
                          {j.path}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {!separateBranch && !isTerminal && (
            <p className="text-xs text-waiting">
              The {isTerminal ? 'shell' : 'agent'} commits straight to{' '}
              <span className="font-mono">{baseName || '…'}</span>
              {sharingDirectory
                ? ' and shares its working directory with concurrent sessions — they can trample each other’s edits.'
                : '.'}
            </p>
          )}

          {showSkipToggle && (
            <div className="flex items-center gap-2 rounded-md bg-surface px-3 py-2">
              <Switch id="skip-permissions" checked={skip} onCheckedChange={setSkip} />
              <Label htmlFor="skip-permissions" className="text-waiting">
                Skip permission prompts for this session
              </Label>
            </div>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={(!isTerminal && !effectiveAccountId) || create.isPending}
            >
              {isTerminal ? 'Open terminal' : 'Start session'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
