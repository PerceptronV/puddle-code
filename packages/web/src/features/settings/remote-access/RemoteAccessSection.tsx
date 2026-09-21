import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import {
  cockpitRemoteStatusSchema,
  remoteAdminResponseSchema,
  type CockpitRemoteRequest,
} from '@puddle/shared';
import { api, ApiError } from '../../../lib/api';
import { useHostInfo } from '../../../lib/queries';
import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '../../../components/ui/dialog';
import { SectionTitle } from '../parts';
import { RegistrationForm } from './RegistrationForm';
import { PairingInvitation } from './PairingInvitation';
import { DeviceList } from './DeviceList';

export function RemoteAccessSection() {
  const host = useHostInfo();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [replace, setReplace] = useState(false);
  const [reset, setReset] = useState(false);
  const [invitation, setInvitation] = useState<{ url: string; expires: number } | null>(null);
  const dismiss = useCallback(() => setInvitation(null), []);
  const status = useQuery({
    queryKey: ['cockpit-remote'],
    queryFn: async () => cockpitRemoteStatusSchema.parse(await api('GET', '/cockpit/remote')),
    refetchInterval: busy ? false : 5000,
    retry: false,
    gcTime: 0,
  });
  const act = async (request: CockpitRemoteRequest): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = remoteAdminResponseSchema.parse(await api('POST', '/cockpit/remote', request));
      if (request.t === 'pair' && result.url && result.invitation)
        setInvitation({ url: result.url, expires: result.invitation.expires });
      else {
        setMessage(
          {
            enable: 'Remote access enabled.',
            approve: 'Browser approved.',
            revoke: 'Browser revoked.',
            disable: 'Remote access disabled. Agents continue running.',
            reset: 'Host identity rotated and all browsers revoked. Enable access and pair again.',
            status: 'Status refreshed.',
            devices: 'Browsers refreshed.',
            pair: 'Invitation created.',
          }[request.t],
        );
        if (request.t === 'disable' || request.t === 'reset' || request.t === 'enable') dismiss();
      }
      if (request.t === 'enable') setReplace(false);
      setReset(false);
      await status.refetch();
      return true;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Host operation failed. Refresh status before retrying.',
      );
      await status.refetch();
      return false;
    } finally {
      setBusy(false);
    }
  };
  const data = status.data;
  const unavailable = status.error instanceof ApiError && status.error.status === 404;
  const disabled = busy || status.isFetching || status.isError;
  return (
    <div>
      <SectionTitle
        note={`Applies to ${host.data?.displayName || host.data?.hostname || 'the host open in this window'}, across all profiles`}
      >
        Remote access
      </SectionTitle>
      <p className="mt-3 text-sm text-fg-secondary">
        Connect a phone or another browser through your self-hosted relay. Paired browsers can
        control terminals on this host.
      </p>
      <div className="mt-5 flex items-center justify-between gap-3">
        <span role="status" className="text-sm font-medium">
          {status.isError
            ? 'Status unavailable'
            : !data
              ? 'Checking remote access…'
              : data.availability !== 'ready'
                ? 'Daemon upgrade required'
                : !data.configured
                  ? 'Not configured'
                  : !data.enabled
                    ? 'Disabled'
                    : data.connected
                      ? 'Connected to relay'
                      : 'Enabled · relay disconnected'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || status.isFetching}
          onClick={() => void status.refetch()}
        >
          <RefreshCw />
          Refresh status
        </Button>
      </div>
      {status.isError && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {unavailable
            ? 'This cockpit does not provide remote controls. Update Puddle and reopen this window.'
            : status.error.message}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mt-3 text-sm text-fg-secondary">
          {message}
        </p>
      )}
      {data?.availability !== undefined && data.availability !== 'ready' && (
        <p className="mt-3 text-sm text-fg-secondary">
          Update the daemon on this host, then refresh status to set up mobile access.
        </p>
      )}
      {data?.availability === 'ready' && (
        <>
          {data.configured && (
            <dl className="mt-4 space-y-2 text-xs text-fg-secondary">
              <div>
                <dt className="text-fg-muted">Application</dt>
                <dd className="break-all">
                  <a href={data.app} target="_blank" rel="noreferrer" className="hover:text-fg">
                    {data.app} ↗
                  </a>
                </dd>
              </div>
              <div>
                <dt className="text-fg-muted">Relay</dt>
                <dd className="break-all">{data.service}</dd>
              </div>
              {data.peer && (
                <div>
                  <dt className="text-fg-muted">Host identity</dt>
                  <dd className="break-all font-mono">{data.peer}</dd>
                </div>
              )}
            </dl>
          )}
          {!data.enabled && !data.supervisor && (
            <p className="mt-4 text-sm text-fg-secondary">
              This host needs persistent systemd or launchd supervision before access can be enabled
              here. For another supervisor, configure both the daemon and connector using the remote
              CLI commands.
            </p>
          )}
          {!data.enabled && data.supervisor && (
            <>
              {data.configured && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button disabled={disabled} onClick={() => void act({ t: 'enable' })}>
                    Enable remote access
                  </Button>
                  <Button variant="ghost" disabled={disabled} onClick={() => setReplace(!replace)}>
                    {replace ? 'Cancel registration change' : 'Change registration'}
                  </Button>
                </div>
              )}
              {(!data.configured || replace) && (
                <>
                  {replace && (
                    <p className="mt-4 text-sm text-fg-secondary">
                      Changing registration revokes existing browser approvals and invitations.
                    </p>
                  )}
                  <RegistrationForm
                    key={data.host ?? 'new'}
                    service={data.service}
                    app={data.app}
                    busy={disabled}
                    enable={act}
                  />
                </>
              )}
            </>
          )}
          {data.enabled && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button disabled={disabled} onClick={() => void act({ t: 'pair' })}>
                Pair a browser
              </Button>
              <Button
                variant="ghost"
                disabled={disabled}
                onClick={() => void act({ t: 'disable' })}
              >
                Disable remote access
              </Button>
            </div>
          )}
          {invitation && data.enabled && <PairingInvitation {...invitation} dismiss={dismiss} />}
          {data.configured && (
            <>
              <DeviceList
                devices={data.devices}
                now={status.dataUpdatedAt}
                busy={disabled}
                act={act}
              />
              <p className="mt-4 text-xs text-fg-muted">
                Revocation and disabling detach remote viewers; agents continue running. Browsers
                expire after 30 days of inactivity or 90 days overall.
              </p>
              <details className="mt-6 text-sm">
                <summary className="cursor-pointer py-2 text-fg-secondary hover:text-fg">
                  Host identity recovery
                </summary>
                <p className="my-3 text-xs text-fg-muted">
                  Rotate a lost or compromised host identity. All browser approvals and invitations
                  will be revoked.
                </p>
                <Button variant="ghost" disabled={disabled} onClick={() => setReset(true)}>
                  Reset host identity…
                </Button>
              </details>
            </>
          )}
        </>
      )}
      <Dialog open={reset} onOpenChange={(open) => !busy && setReset(open)}>
        <DialogContent>
          <DialogTitle>Reset this host’s remote identity?</DialogTitle>
          <DialogDescription>
            Disable remote access, rotate the host identity and revoke every paired browser and
            invitation. Agents keep running. Enable access and pair each browser again afterwards.
          </DialogDescription>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setReset(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void act({ t: 'reset' })}>
              Reset host identity
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
