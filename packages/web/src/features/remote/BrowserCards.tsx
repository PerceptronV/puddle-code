import { ShieldCheck, Trash2 } from 'lucide-react';
import { REMOTE_POLICY, type RemoteDevice } from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { Disclosure } from '../../components/ui/disclosure';
import { cn } from '../../lib/utils';

type BrowserActions = {
  busy: boolean;
  approve(id: string): void;
  revoke(id: string): void;
};

/** The same compact account-style cards in desktop settings and remote access. */
export function BrowserCards({
  devices,
  now,
  currentDevice,
  ...actions
}: BrowserActions & {
  devices: RemoteDevice[];
  now: number;
  currentDevice?: string;
}) {
  const visible = devices
    .filter((device) => device.status !== 'revoked')
    .sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'));
  return (
    <div className="grid gap-2">
      {visible.length === 0 && (
        <p className="text-xs text-fg-muted">
          No browsers yet. Create a pairing invitation to add one.
        </p>
      )}
      {visible.map((device) => (
        <BrowserCard
          key={device.id}
          device={device}
          now={now}
          current={device.id === currentDevice}
          {...actions}
        />
      ))}
    </div>
  );
}

function BrowserCard({
  device,
  now,
  current,
  busy,
  approve,
  revoke,
}: BrowserActions & {
  device: RemoteDevice;
  now: number;
  current: boolean;
}) {
  const pending = device.status === 'pending';
  const expires =
    device.status === 'approved'
      ? Math.min(device.expires, device.lastUsed + REMOTE_POLICY.idleMs)
      : device.expires;
  const expired = expires <= now;
  const status = expired ? 'Expired' : pending ? 'Awaiting approval' : 'Approved';
  const label = (
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm text-fg" title={device.label}>
        {device.label}
      </p>
      <p
        className={cn(
          'text-2xs',
          expired ? 'text-fg-muted' : pending ? 'text-warning' : 'text-success',
        )}
      >
        {status}
        {current && <span className="text-fg-muted"> · this browser</span>}
      </p>
    </div>
  );
  const details = (
    <div className="mt-2 space-y-1 text-2xs text-fg-muted">
      <code className="block break-all text-fg-secondary">{device.peer}</code>
      <p>
        {expired ? 'Expired' : 'Expires'} {new Date(expires).toLocaleString()}
      </p>
    </div>
  );
  return (
    <article aria-label={device.label} className="min-w-0 rounded-md bg-surface px-3 py-2">
      <div className="flex items-start gap-2">
        {pending ? (
          label
        ) : (
          <Disclosure
            className="min-w-0 flex-1"
            summary={label}
            summaryClassName="flex-row-reverse gap-2 [&>svg]:m-2"
          >
            {details}
          </Disclosure>
        )}
        {pending && !expired && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => approve(device.id)}
            aria-label={`Approve ${device.label}`}
          >
            <ShieldCheck /> Approve
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 text-fg-muted"
          disabled={busy}
          aria-label={`Revoke ${device.label}`}
          title="Revoke browser"
          onClick={() => revoke(device.id)}
        >
          <Trash2 />
        </Button>
      </div>
      {pending && details}
    </article>
  );
}
