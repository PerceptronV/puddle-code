import type { CockpitRemoteRequest, RemoteDevice } from '@puddle/shared';
import { Disclosure } from '../../../components/ui/disclosure';
import { BrowserCards } from '../../remote/BrowserCards';

export function DeviceList({
  devices,
  now,
  busy,
  act,
  canManageMaintenance,
}: {
  devices: RemoteDevice[];
  now: number;
  busy: boolean;
  canManageMaintenance: boolean;
  act(request: CockpitRemoteRequest): Promise<boolean>;
}) {
  return (
    <Disclosure className="mt-6 text-sm" summary="Connected browsers" summaryClassName="py-2">
      <section className="space-y-3 pt-2" aria-label="Browsers">
        <p className="text-xs text-fg-muted">
          Approval grants terminal control of this host. Compare the identity with the browser
          requesting access.
        </p>
        <BrowserCards
          devices={devices}
          now={now}
          busy={busy}
          approve={(id) => void act({ t: 'approve', id })}
          revoke={(id) => void act({ t: 'revoke', id })}
          maintenance={
            canManageMaintenance
              ? (id, enabled) => void act({ t: 'maintenance', id, enabled })
              : undefined
          }
        />
        <p className="text-xs text-fg-muted">
          Revocation detaches viewers; agents continue running. Browsers expire after 30 days of
          inactivity or 90 days overall.
        </p>
        {canManageMaintenance && (
          <p className="text-xs text-fg-muted">
            Host maintenance separately allows daemon and runtime software updates. Updates can
            affect every profile on this host. Pairing alone does not grant it or permission to
            restart other profiles' runtimes.
          </p>
        )}
      </section>
    </Disclosure>
  );
}
