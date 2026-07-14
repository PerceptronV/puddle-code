import { useState } from 'react';
import { KeyRound, Plus, Settings2 } from 'lucide-react';
import type { Account } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { openSettings } from '../../lib/hash-route';
import {
  useAccountUsage,
  useAccounts,
  useAgents,
  useLoginAccount,
  useProfiles,
} from '../../lib/queries';
import { LoginDialog } from '../accounts/LoginDialog';
import { useNewSession } from '../shell/new-session-context';
import { profileStore, useCurrentProfileId } from './profile-store';

/** Compact token count: 12345 → 12.3k, 4200000 → 4.2M. */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function relativeTime(iso: string | null): string {
  if (iso === null) return 'never';
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * One account row: a status dot, the label, usage summary, and the primary
 * action — logged out → sign in; logged in inside a project → new session on
 * this account. Rows are clickable in their entirety.
 */
function AccountRow({
  account,
  onLogin,
  onStartSession,
}: {
  account: Account;
  onLogin: () => void;
  onStartSession: (() => void) | null;
}) {
  const usage = useAccountUsage(account.id);
  const action = account.logged_in ? onStartSession : onLogin;

  return (
    <button
      type="button"
      disabled={action === null}
      onClick={() => action?.()}
      className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-100"
    >
      <span
        className={`size-2 shrink-0 rounded-full ${account.logged_in ? 'bg-running' : 'bg-idle'}`}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-sm text-fg">{account.label}</span>
        <span className="block text-2xs text-fg-muted">
          {account.logged_in ? 'logged in' : 'logged out'}
          {usage.data && (
            <>
              {' · '}
              {usage.data.session_count} session{usage.data.session_count === 1 ? '' : 's'}
              {usage.data.active_session_count > 0 &&
                ` (${usage.data.active_session_count} active)`}
              {' · '}last {relativeTime(usage.data.last_activity_at)}
            </>
          )}
        </span>
        {usage.data?.agent_usage && (
          <span className="block text-2xs text-fg-muted">
            {compact(usage.data.agent_usage.input_tokens)} in ·{' '}
            {compact(usage.data.agent_usage.output_tokens)} out ·{' '}
            {compact(usage.data.agent_usage.cache_read_input_tokens)} cached ·{' '}
            {usage.data.agent_usage.message_count} msgs
          </span>
        )}
      </span>
      <span className="shrink-0 text-2xs text-fg-muted">
        {account.logged_in ? (
          onStartSession ? (
            'new session'
          ) : (
            ''
          )
        ) : (
          <span className="flex items-center gap-1 text-waiting">
            <KeyRound className="size-3" />
            sign in
          </span>
        )}
      </span>
    </button>
  );
}

/** The profile panel: accounts grouped by agent type, with status, usage, actions. */
export function ProfilePanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const profileId = useCurrentProfileId();
  const profiles = useProfiles();
  const currentProfile = profiles.data?.find((p) => p.id === profileId);
  const accounts = useAccounts(profileId ?? undefined);
  const agents = useAgents();
  const login = useLoginAccount();
  const { open: openNewSession, handler } = useNewSession();
  const [loginStream, setLoginStream] = useState<{ stream: string; label: string } | null>(null);

  const startLogin = (account: Account) =>
    login.mutate(account.id, {
      onSuccess: (res) =>
        setLoginStream({ stream: res.stream, label: `${account.agent_type}/${account.label}` }),
    });

  const startSession = (account: Account) => {
    onOpenChange(false);
    openNewSession({ accountId: account.id });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-mono">{currentProfile?.name ?? 'Profile'}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {(agents.data ?? []).map((agent) => {
              const forAgent = accounts.data?.filter((a) => a.agent_type === agent.id) ?? [];
              if (forAgent.length === 0) return null;
              return (
                <div key={agent.id} className="flex flex-col gap-0.5">
                  <span className="px-2 text-2xs font-medium uppercase tracking-wide text-fg-muted">
                    {agent.display_name}
                  </span>
                  {forAgent.map((account) => (
                    <AccountRow
                      key={account.id}
                      account={account}
                      onLogin={() => startLogin(account)}
                      // A session can only start inside a workspace.
                      onStartSession={handler ? () => startSession(account) : null}
                    />
                  ))}
                </div>
              );
            })}
            {accounts.data?.length === 0 && (
              <p className="px-2 text-sm text-fg-muted">No accounts yet — add one in settings.</p>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onOpenChange(false);
                openSettings('accounts');
              }}
            >
              <Plus />
              Add account
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => {
                onOpenChange(false);
                profileStore.set(null); // back to the picker
              }}
            >
              <Settings2 />
              Switch profile
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {loginStream && (
        <LoginDialog
          stream={loginStream.stream}
          label={loginStream.label}
          onClose={() => setLoginStream(null)}
        />
      )}
    </>
  );
}
