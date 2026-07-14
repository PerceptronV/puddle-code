import { useEffect, useState } from 'react';
import { FolderInput, KeyRound, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { Account } from '@puddle/shared';
import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { HintInput } from '../../../components/ui/hint-input';
import { Input } from '../../../components/ui/input';
import { Switch } from '../../../components/ui/switch';
import {
  useAccounts,
  useAgents,
  useCreateAccount,
  useDeleteAccount,
  useDirSuggestions,
  useLoginAccount,
  usePatchAccount,
  useProfileSettings,
} from '../../../lib/queries';
import { useDebouncedValue } from '../../../lib/use-debounced-value';
import { LoginDialog } from '../../accounts/LoginDialog';
import { useCurrentProfileId } from '../../profile/profile-store';
import { SectionTitle, SettingRow } from '../parts';

/** Import an existing config dir: puddle copies it, the source stays put. */
function ImportDialog({
  agentId,
  profileId,
  onClose,
}: {
  agentId: string;
  profileId: string;
  onClose: () => void;
}) {
  const create = useCreateAccount();
  const [label, setLabel] = useState('');
  const [dir, setDir] = useState('');
  const debouncedDir = useDebouncedValue(dir, 150);
  const suggestions = useDirSuggestions(debouncedDir);
  const ready = label.trim() !== '' && (dir.startsWith('/') || dir.startsWith('~'));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import an existing account</DialogTitle>
          <DialogDescription>
            The directory is copied into a puddle-owned account; the original is never touched. If
            credentials do not travel (macOS keychain), log in once afterwards.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            placeholder="label, e.g. personal"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="font-mono"
          />
          <HintInput
            value={dir}
            onValueChange={setDir}
            placeholder="config dir on the host, e.g. ~/.claude"
            hints={(suggestions.data?.entries ?? []).map((e) => ({ value: e.path, label: e.name }))}
            className="font-mono"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!ready || create.isPending}
            onClick={() =>
              create.mutate(
                {
                  profile_id: profileId,
                  agent_type: agentId,
                  label: label.trim(),
                  import_dir: dir.trim(),
                },
                {
                  onSuccess: (account) => {
                    onClose();
                    if (!account.logged_in)
                      toast.info('Imported without credentials — press Login to authenticate.');
                  },
                  onError: (e) => toast.error(e.message),
                },
              )
            }
          >
            <FolderInput />
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountRow({ account, gateOpen }: { account: Account; gateOpen: boolean }) {
  const login = useLoginAccount();
  const patch = usePatchAccount();
  const remove = useDeleteAccount();
  const [loginStream, setLoginStream] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Editable label: local while typing, saved on blur/Enter, reverted on Escape.
  const [label, setLabel] = useState(account.label);
  useEffect(() => setLabel(account.label), [account.label]);

  const commitLabel = () => {
    const next = label.trim();
    if (next === account.label) return;
    if (next === '') {
      setLabel(account.label);
      return;
    }
    patch.mutate(
      { id: account.id, label: next },
      {
        onError: (e) => {
          toast.error(e.message);
          setLabel(account.label);
        },
      },
    );
  };

  return (
    <div className="flex items-center gap-3 rounded-md bg-surface px-3 py-2">
      <span className="min-w-0 flex-1">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') {
              setLabel(account.label);
              e.currentTarget.blur();
            }
          }}
          aria-label="Account name"
          className="-mx-1 block w-full truncate rounded-sm bg-transparent px-1 py-0.5 font-mono text-sm text-fg transition-colors hover:bg-elevated focus:bg-elevated focus:outline-none"
        />
        <span className={`text-2xs ${account.logged_in ? 'text-running' : 'text-waiting'}`}>
          {account.logged_in ? 'logged in' : 'not logged in'}
        </span>
      </span>
      {gateOpen && (
        <label className="flex items-center gap-2 text-xs text-fg-secondary">
          skip prompts
          <Switch
            checked={account.skip_permissions_default}
            onCheckedChange={(checked) =>
              patch.mutate(
                { id: account.id, skip_permissions_default: checked },
                { onError: (e) => toast.error(e.message) },
              )
            }
          />
        </label>
      )}
      <Button
        size="sm"
        variant="secondary"
        disabled={login.isPending}
        onClick={() =>
          login.mutate(account.id, {
            onSuccess: (res) => setLoginStream(res.stream),
            onError: (e) => toast.error(e.message),
          })
        }
      >
        <KeyRound />
        {account.logged_in ? 'Re-login' : 'Login'}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7 text-fg-muted hover:text-danger"
        onClick={() => setConfirmingDelete(true)}
      >
        <Trash2 />
        <span className="sr-only">Delete account</span>
      </Button>
      {loginStream && (
        <LoginDialog
          stream={loginStream}
          label={`${account.agent_type}/${account.label}`}
          onClose={() => setLoginStream(null)}
        />
      )}
      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete <span className="font-mono">{account.label}</span>?
            </DialogTitle>
            <DialogDescription>
              Removes the account, its archived session history, and its credential directory — this
              logs the account out. Non-archived sessions block deletion.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(account.id, {
                  onSuccess: () => setConfirmingDelete(false),
                  onError: (e) => {
                    setConfirmingDelete(false);
                    toast.error(e.message);
                  },
                })
              }
            >
              Delete account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function AccountsSection() {
  const profileId = useCurrentProfileId();
  const agents = useAgents();
  const accounts = useAccounts(profileId ?? undefined);
  const settings = useProfileSettings(profileId ?? undefined);
  const create = useCreateAccount();
  const login = useLoginAccount();
  const [newLabels, setNewLabels] = useState<Record<string, string>>({});
  const [loginStream, setLoginStream] = useState<{ stream: string; label: string } | null>(null);
  const [importingAgent, setImportingAgent] = useState<string | null>(null);

  const gateOpen = settings.data?.allowSkipPermissions === true;

  const addAccount = (agentId: string) => {
    const label = (newLabels[agentId] ?? '').trim();
    if (!label || profileId === null) return;
    create.mutate(
      { profile_id: profileId, agent_type: agentId, label },
      {
        onSuccess: (account) => {
          setNewLabels((labels) => ({ ...labels, [agentId]: '' }));
          // Straight into the login flow (SPEC §11).
          login.mutate(account.id, {
            onSuccess: (res) =>
              setLoginStream({ stream: res.stream, label: `${agentId}/${account.label}` }),
          });
        },
        onError: (e) => toast.error(e.message),
      },
    );
  };

  return (
    <div>
      <SectionTitle>Accounts</SectionTitle>
      {agents.data?.map((agent) => {
        const agentAccounts = accounts.data?.filter((a) => a.agent_type === agent.id) ?? [];
        return (
          <div key={agent.id} className="mb-5">
            <SettingRow
              label={agent.display_name}
              description="Accounts are isolated config dirs under this profile."
              className="py-1"
            >
              <span className="font-mono text-2xs text-fg-muted">{agent.id}</span>
            </SettingRow>
            <div className="flex flex-col gap-1.5">
              {agentAccounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  gateOpen={gateOpen && agent.capabilities.skip_permissions}
                />
              ))}
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  addAccount(agent.id);
                }}
              >
                <Input
                  placeholder="label, e.g. personal"
                  value={newLabels[agent.id] ?? ''}
                  onChange={(e) => setNewLabels((l) => ({ ...l, [agent.id]: e.target.value }))}
                  className="w-48 font-mono"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={!(newLabels[agent.id] ?? '').trim() || create.isPending}
                >
                  <Plus />
                  Add account
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setImportingAgent(agent.id)}
                >
                  <FolderInput />
                  Import existing…
                </Button>
              </form>
            </div>
          </div>
        );
      })}
      {loginStream && (
        <LoginDialog
          stream={loginStream.stream}
          label={loginStream.label}
          onClose={() => setLoginStream(null)}
        />
      )}
      {importingAgent !== null && profileId !== null && (
        <ImportDialog
          agentId={importingAgent}
          profileId={profileId}
          onClose={() => setImportingAgent(null)}
        />
      )}
    </div>
  );
}
