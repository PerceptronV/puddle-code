import { Button } from '../../components/ui/button';
import { hostLabel, useHostInfo } from '../../lib/queries/queries';
import { ApiError } from '../../lib/transport/api';
import { SectionTitle, SettingRow } from '../settings/parts';
import { availableHostUpdates, updateInProgress } from './model';
import { useHostUpdateAccess, useHostUpdateAction, useHostUpdates } from './queries';
import { OperationReview } from './OperationReview';

export function HostUpdatesSection() {
  const status = useHostUpdates();
  const allowed = useHostUpdateAccess();
  const action = useHostUpdateAction();
  const name = hostLabel(useHostInfo().data) ?? 'this host';
  if (!allowed) return null;
  const data = status.data;
  const catalogue = data?.catalogue;
  const releases = catalogue?.releases;
  const targets = availableHostUpdates(data);
  const missing = status.error instanceof ApiError && status.error.status === 404;
  const disabled = action.busy || status.isError || data?.availability !== 'ready';
  const rejected =
    action.data && !action.data.ok
      ? action.data
      : data?.result && !data.result.ok
        ? data.result
        : null;
  return (
    <section className="mb-8" aria-label="Host updates">
      <SectionTitle note={`Updates run on ${name}`}>Updates</SectionTitle>
      <SettingRow
        label="Daemon"
        description={
          data?.observation === 'recorded'
            ? data.daemon_version
              ? `Last connected version: ${data.daemon_version}`
              : 'Version unavailable'
            : (catalogue?.daemon_version ?? data?.daemon_version ?? 'Version unavailable')
        }
      >
        <Button
          variant="ghost"
          size="sm"
          disabled={status.isFetching}
          onClick={() => void status.refetch({ cancelRefetch: false })}
        >
          {status.isFetching ? 'Refreshing…' : 'Refresh status'}
        </Button>
      </SettingRow>
      {catalogue && (
        <>
          <SettingRow
            label="Default runtime software"
            description="New runtimes use this build. Existing runtimes retain their current build."
          >
            <span className="text-xs tabular-nums">
              {catalogue.runtime_default?.version ?? 'Unavailable'}
            </span>
          </SettingRow>
          {catalogue.runtimes.versions.length > 0 && (
            <div className="my-3 space-y-1 text-xs text-fg-secondary">
              <p className="font-medium">Existing runtimes</p>
              {catalogue.runtimes.versions.map((runtime) => (
                <p key={`${runtime.version}-${runtime.protocol.major}-${runtime.protocol.minor}`}>
                  {runtime.version}: {runtime.running} connected · {runtime.starting} starting ·{' '}
                  {runtime.unavailable} unavailable
                </p>
              ))}
            </div>
          )}
          {!catalogue.runtimes.complete && (
            <p className="my-2 text-xs text-warning">
              Runtime inventory is incomplete. Update review checks compatibility separately.
            </p>
          )}
        </>
      )}
      {!data && !status.isError && (
        <p role="status" className="text-sm text-fg-muted">
          Checking host updates…
        </p>
      )}
      {status.isError && (
        <p role="alert" className="text-sm text-warning">
          {missing
            ? 'Update this frontend and reopen the window to manage host updates.'
            : 'Host status is unavailable. The last observation may be out of date. Refresh status before another action.'}
        </p>
      )}
      {data?.availability === 'upgrade_required' && (
        <p className="text-sm text-fg-secondary">
          This daemon needs an upgrade before frontend update controls are available.
        </p>
      )}
      {data?.availability === 'unavailable' && (
        <p role="status" className="text-sm text-fg-secondary">
          {data.observation === 'recorded'
            ? 'The daemon is unavailable. Showing the update record from this host.'
            : 'Waiting for the daemon to reconnect.'}{' '}
          No update action will be repeated.
        </p>
      )}
      {releases && (
        <div className="my-4 space-y-1 text-xs text-fg-secondary">
          <p>
            {releases.state === 'unconfigured'
              ? 'No release source is configured on this host.'
              : releases.state === 'checking'
                ? 'Checking for releases…'
                : releases.state === 'failed'
                  ? 'Release check failed. Showing the last known result.'
                  : 'Release check completed.'}
          </p>
          {releases.latest && (
            <p>
              Latest known release: {releases.latest.version}
              {!releases.components &&
                !releases.latest.host_asset &&
                ' · No package available for this host'}
            </p>
          )}
          {releases.components && (
            <p>
              Latest daemon: {releases.components.daemon.version}
              {!releases.components.daemon.host_asset && ' (unavailable for this host)'}
              {' · '}Runtime: {releases.components.runtime.version}
              {!releases.components.runtime.host_asset && ' (unavailable for this host)'}
            </p>
          )}
          {releases.succeeded_at !== null && (
            <p>Last successful check: {new Date(releases.succeeded_at).toLocaleString()}</p>
          )}
        </div>
      )}
      {targets.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {targets.map((target) => (
            <Button
              key={target.component}
              size="sm"
              disabled={disabled || updateInProgress(data)}
              onClick={() => action.act({ action: 'prepare', targets: [target] })}
            >
              Prepare {target.component === 'daemon' ? 'daemon' : 'runtime software'}{' '}
              {target.version}
            </Button>
          ))}
          {targets.length > 1 && (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || updateInProgress(data)}
              onClick={() => action.act({ action: 'prepare', targets })}
            >
              Prepare both
            </Button>
          )}
        </div>
      )}
      {targets.length > 0 && (
        <p className="mt-2 text-xs text-fg-muted">
          Preparation downloads and verifies the release. Review its impact before applying.
        </p>
      )}
      {action.busy && (
        <p role="status" className="mt-3 text-sm text-fg-secondary">
          {action.variables?.action === 'prepare' ? 'Preparing update…' : 'Waiting for the host…'}
        </p>
      )}
      {action.isError && (
        <p role="alert" className="mt-3 text-sm text-warning">
          The response was lost or unavailable. Status is being checked; the action has not been
          repeated.
        </p>
      )}
      {rejected && (
        <p role="alert" className="mt-3 text-sm text-warning">
          {rejected.code === 'conflict'
            ? 'The host changed since review. Refresh status and review again.'
            : `The host could not complete the request (${rejected.code}). Refresh status before another action.`}
        </p>
      )}
      {data && (
        <OperationReview
          status={data}
          reply={action.data}
          disabled={disabled}
          offlineDisabled={action.busy || status.isError}
          act={action.act}
        />
      )}
    </section>
  );
}
