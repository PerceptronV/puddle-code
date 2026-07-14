import { useMemo, useState } from 'react';
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
import { useAccounts, useCreateSession, useProfileSettings, useRepos } from '../../lib/queries';
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
  onOpenChange,
  onCreated,
}: {
  projectId: number;
  repoId: number;
  open: boolean;
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
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [skip, setSkip] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repo = repos.data?.find((r) => r.id === repoId);
  const account = accounts.data?.find((a) => String(a.id) === accountId);
  const gateOpen = settings.data?.allowSkipPermissions === true;
  const showSkipToggle = gateOpen && account?.skip_permissions_default === true;

  const defaultAccount = useMemo(() => accounts.data?.[0], [accounts.data]);
  const effectiveAccountId = accountId || (defaultAccount ? String(defaultAccount.id) : '');

  const submit = () => {
    setError(null);
    create.mutate(
      {
        project_id: projectId,
        account_id: Number(effectiveAccountId),
        ...(baseBranch.trim() ? { base_branch: baseBranch.trim() } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(showSkipToggle && skip ? { skip_permissions: true } : {}),
      },
      {
        onSuccess: (session) => {
          onOpenChange(false);
          setTitle('');
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
            Spawns an agent in a fresh worktree branched from{' '}
            <span className="font-mono">
              {baseBranch.trim() || repo?.default_base_branch || '…'}
            </span>
            .
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
            <Input
              id="base-branch"
              placeholder={repo?.default_base_branch ?? 'main'}
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              className="font-mono"
            />
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
            <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
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
