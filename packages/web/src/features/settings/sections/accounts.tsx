import { useState } from 'react';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
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
import { Input } from '../../../components/ui/input';
import { Switch } from '../../../components/ui/switch';
import {
  useAccounts,
  useAgents,
  useCreateAccount,
  useDeleteAccount,
  useLoginAccount,
  usePatchAccount,
  useProfileSettings,
} from '../../../lib/queries';
import { LazyTerminal } from '../../terminal/LazyTerminal';
import { useCurrentProfileId } from '../../profile/profile-store';
import { SectionTitle, SettingRow } from '../parts';

/** In-app login: a terminal dialog attached to the account's login PTY. */
function LoginDialog({
  stream,
  label,
  onClose,
}: {
  stream: string;
  label: string;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide className="h-[28rem]">
        <DialogHeader>
          <DialogTitle className="font-mono">{label} — login</DialogTitle>
          <DialogDescription>
            Complete the agent&apos;s login flow below. The account shows as logged in once it
            finishes cleanly.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden rounded-md bg-ground p-1">
          <LazyTerminal stream={stream} onExit={onClose} />
        </div>
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

  return (
    <div className="flex items-center gap-3 rounded-md bg-surface px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-sm text-fg">{account.label}</span>
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
    </div>
  );
}
