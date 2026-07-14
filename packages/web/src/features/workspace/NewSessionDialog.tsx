import { useEffect, useMemo, useState } from 'react';
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
import { HintInput } from '../../components/ui/hint-input';
import { Input, Textarea } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { Switch } from '../../components/ui/switch';
import { openSettings } from '../../lib/hash-route';
import {
  useAccounts,
  useCreateSession,
  useProfileSettings,
  useProfiles,
  useRepoBranches,
  useRepos,
} from '../../lib/queries';
import { useCurrentProfileId } from '../profile/profile-store';

/**
 * Account → base branch → title/prompt (SPEC §11: the project supplies the
 * rest). The skip toggle renders only when the profile gate is on AND the
 * chosen account opted in; the daemon re-checks server-side regardless.
 */
export function NewSessionDialog({
  projectId,
  repoId,
  open,
  seedAccountId,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  repoId: number;
  open: boolean;
  /** Preselects the account picker (profile panel → session on this account). */
  seedAccountId?: number;
  onOpenChange: (open: boolean) => void;
  onCreated: (session: Session) => void;
}) {
  const profileId = useCurrentProfileId();
  const accounts = useAccounts(profileId ?? undefined);
  const settings = useProfileSettings(profileId ?? undefined);
  const repos = useRepos();
  const create = useCreateSession();

  const [accountId, setAccountId] = useState<string>('');
  const [baseBranch, setBaseBranch] = useState('');
  const [separateBranch, setSeparateBranch] = useState(true);
  const [branch, setBranch] = useState('');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [skip, setSkip] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repo = repos.data?.find((r) => r.id === repoId);
  const branches = useRepoBranches(open ? repoId : undefined);
  const profiles = useProfiles();
  const branchPrefix = profiles.data?.find((p) => p.id === profileId)?.branch_prefix ?? '';
  // Mirrors the daemon's naming chain so the placeholder tells the truth.
  const titleSlug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const branchPreview = `${branchPrefix}${titleSlug || 'auto — from the prompt, or a word pair'}`;
  const account = accounts.data?.find((a) => String(a.id) === accountId);
  const gateOpen = settings.data?.allowSkipPermissions === true;
  const showSkipToggle = gateOpen && account?.skip_permissions_default === true;

  // A seed account (from the profile panel) wins; else the profile's default
  // account from settings; else the first one.
  const defaultAccount = useMemo(() => {
    const preferred = settings.data?.['default_account_id'];
    return (
      accounts.data?.find((a) => a.id === seedAccountId) ??
      accounts.data?.find((a) => typeof preferred === 'number' && a.id === preferred) ??
      accounts.data?.[0]
    );
  }, [accounts.data, settings.data, seedAccountId]);
  const effectiveAccountId = accountId || (defaultAccount ? String(defaultAccount.id) : '');

  // A fresh seed (panel reopened on a different account) overrides any manual
  // pick from a previous opening.
  useEffect(() => {
    if (open && seedAccountId !== undefined) setAccountId(String(seedAccountId));
  }, [open, seedAccountId]);

  const submit = () => {
    setError(null);
    create.mutate(
      {
        project_id: projectId,
        account_id: Number(effectiveAccountId),
        ...(baseBranch.trim() ? { base_branch: baseBranch.trim() } : {}),
        ...(separateBranch ? {} : { separate_branch: false }),
        ...(separateBranch && branch.trim() ? { branch: branch.trim() } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(showSkipToggle && skip ? { skip_permissions: true } : {}),
      },
      {
        onSuccess: (session) => {
          onOpenChange(false);
          setTitle('');
          setBranch('');
          setSeparateBranch(true);
          setPrompt('');
          setSkip(false);
          onCreated(session);
        },
        // A 400 skip_permissions_denied (or anything else) renders verbatim.
        onError: (e) => setError(e.message),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>
            {separateBranch
              ? 'Spawns an agent in a fresh worktree branched from'
              : 'Spawns an agent directly on'}{' '}
            <span className="font-mono">
              {baseBranch.trim() || repo?.default_base_branch || '…'}
            </span>
            {separateBranch ? '.' : ', in a worktree shared with every other such session.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (effectiveAccountId) submit();
          }}
        >
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
          <div className="flex flex-col gap-1.5">
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
                        ? `session: ${(b.session_title ?? 'untitled').slice(0, 24)}`
                        : undefined,
                }))}
              className="font-mono"
            />
            <div className="flex items-center gap-2 pt-1">
              <Switch
                id="separate-branch"
                checked={separateBranch}
                onCheckedChange={setSeparateBranch}
              />
              <Label htmlFor="separate-branch">Use separate branch</Label>
            </div>
            {!separateBranch && (
              <p className="text-xs text-waiting">
                Discouraged: the agent commits straight to{' '}
                <span className="font-mono">
                  {baseBranch.trim() || repo?.default_base_branch || '…'}
                </span>{' '}
                and shares its directory with every other session working this way — no isolation
                between them.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="session-title">Title</Label>
            <Input
              id="session-title"
              placeholder="e.g. fix flaky auth test"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          {separateBranch && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="session-branch">Branch</Label>
              <Input
                id="session-branch"
                placeholder={branchPreview}
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                className="font-mono"
              />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="session-prompt">First prompt</Label>
            <Textarea
              id="session-prompt"
              placeholder="What should the agent do?"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
            />
          </div>
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
            <Button type="submit" disabled={!effectiveAccountId || create.isPending}>
              Start session
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
