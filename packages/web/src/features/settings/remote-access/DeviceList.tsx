import { REMOTE_POLICY, type CockpitRemoteRequest, type RemoteDevice } from '@puddle/shared';
import { Button } from '../../../components/ui/button';

export function DeviceList({
  devices,
  now,
  busy,
  act,
}: {
  devices: RemoteDevice[];
  now: number;
  busy: boolean;
  act(request: CockpitRemoteRequest): Promise<boolean>;
}) {
  return (
    <section className="mt-6 space-y-4" aria-label="Browsers">
      <h3 className="text-sm font-medium">Browsers</h3>
      <p className="text-xs text-fg-muted">Approval grants terminal control of this host.</p>
      {devices.length === 0 && (
        <p className="text-sm text-fg-secondary">
          No browsers yet. Create a pairing invitation to add one.
        </p>
      )}
      {[...devices]
        .sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'))
        .map((device) => {
          const expires =
            device.status === 'approved'
              ? Math.min(device.expires, device.lastUsed + REMOTE_POLICY.idleMs)
              : device.expires;
          const expired = expires <= now;
          const status =
            device.status === 'revoked'
              ? 'Revoked'
              : expired
                ? 'Expired'
                : device.status === 'pending'
                  ? 'Awaiting approval'
                  : 'Approved';
          return (
            <div key={device.id} className="space-y-1.5 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{device.label}</span>
                <span className="text-xs text-fg-muted">{status}</span>
              </div>
              <code className="block break-all text-xs text-fg-secondary">{device.peer}</code>
              <p className="text-xs text-fg-muted">
                {expired ? 'Expired' : 'Expires'} {new Date(expires).toLocaleString()}
              </p>
              {device.status !== 'revoked' && (
                <div className="flex gap-2 pt-1">
                  {device.status === 'pending' && !expired && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void act({ t: 'approve', id: device.id })}
                    >
                      Approve this identity
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Revoke ${device.label}`}
                    onClick={() => void act({ t: 'revoke', id: device.id })}
                  >
                    Revoke
                  </Button>
                </div>
              )}
            </div>
          );
        })}
    </section>
  );
}
