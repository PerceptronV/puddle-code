import {
  hostUpdateTerminal,
  type FrontendHostUpdateReply,
  type FrontendHostUpdateRequest,
  type FrontendHostUpdateStatus,
} from '@puddle/shared';
import { Button } from '../../components/ui/button';
import { canReview, phaseLabel, reviewedApply, offlineRecoveryRequest } from './model';

export function OperationReview({
  status,
  reply,
  disabled,
  offlineDisabled,
  act,
}: {
  status: FrontendHostUpdateStatus;
  reply: FrontendHostUpdateReply | undefined;
  disabled: boolean;
  offlineDisabled: boolean;
  act: (request: FrontendHostUpdateRequest) => void;
}) {
  const operation = status.result?.operation;
  if (!operation) return null;
  const reference = { id: operation.id, revision: operation.revision };
  const apply = reviewedApply(status, reply);
  const offline = offlineRecoveryRequest(status);
  const review =
    reply?.ok &&
    reply.operation?.id === operation.id &&
    reply.operation.revision === operation.revision
      ? reply.review
      : undefined;
  const terminal = hostUpdateTerminal(operation.phase);
  return (
    <div className="mt-5 space-y-3 text-sm">
      <p role="status" className="font-medium">
        {status.observation === 'recorded' && 'Recorded status: '}
        {phaseLabel[operation.phase]}
      </p>
      {status.observation === 'recorded' && (
        <p className="text-xs text-fg-muted">
          Last recorded change: {new Date(operation.updated_at).toLocaleString()}. This record does
          not confirm current service health or runtime adoption.
        </p>
      )}
      <p className="text-xs text-fg-secondary">
        {operation.targets
          .map(
            ({ component, version }) =>
              `${component === 'daemon' ? 'Daemon' : 'Runtime software'} ${version}`,
          )
          .join(' · ')}
      </p>
      {operation.message && <p className="text-xs text-fg-muted">{operation.message}</p>}
      {apply && (
        <p className="text-xs text-fg-secondary">
          Existing persistent runtimes keep running.{' '}
          {operation.targets.some(({ component }) => component === 'daemon')
            ? 'This window briefly reconnects while the daemon is replaced.'
            : 'New runtimes will use the updated software.'}
        </p>
      )}
      {review && (
        <>
          <p className="text-xs text-fg-secondary">
            Daemon-owned work affected: {review.affected.terminals} terminals,{' '}
            {review.affected.notebooks} notebook kernels, {review.affected.compilation} compilation
            jobs/watchers, {review.affected.programmes} programmes.
          </p>
          {review.interruption_fingerprint && (
            <p className="text-xs text-warning">
              Applying interrupts the listed work. Shell jobs and in-memory kernel state will be
              lost; interrupted programmes are not replayed.
            </p>
          )}
          {review.blockers
            .filter(({ code }) => code !== 'interruption_approval_required')
            .map(({ code }, index) => (
              <p key={`${code}-${index}`} className="text-xs text-warning">
                {code === 'runtime_lifetime_unverified'
                  ? 'A runtime has a limited or unverified host lifetime. Daemon replacement is blocked while it runs. Updating also requires a supported host service manager.'
                  : `Check failed: ${(code === 'cockpit_incompatible' ? 'frontend_incompatible' : code).replaceAll('_', ' ')}`}
              </p>
            ))}
          {review.more_blockers > 0 && (
            <p className="text-xs text-warning">{review.more_blockers} additional checks failed.</p>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {offline && (
          <Button size="sm" disabled={offlineDisabled} onClick={() => act(offline)}>
            Continue recovery on host
          </Button>
        )}
        {canReview(operation) && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => act({ action: 'inspect', reference })}
          >
            {review ? 'Check again' : 'Review impact'}
          </Button>
        )}
        {apply && (
          <Button
            size="sm"
            variant={apply.interruption_approval ? 'danger' : 'default'}
            disabled={disabled}
            onClick={() => act(apply)}
          >
            {apply.interruption_approval ? 'Interrupt listed work and apply' : 'Apply update'}
          </Button>
        )}
        {!terminal && !operation.dispatched && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => act({ action: 'cancel', reference })}
          >
            Cancel update
          </Button>
        )}
        {!terminal && operation.dispatched && status.capabilities.verify_completion && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => act({ action: 'recover', reference, strategy: 'verify-completion' })}
          >
            Verify completion
          </Button>
        )}
        {operation.phase === 'recovery_required' && status.capabilities.continue_recovery && (
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => act({ action: 'recover', reference, strategy: 'continue' })}
          >
            Continue recovery
          </Button>
        )}
      </div>
      {offline && (
        <p className="text-xs text-fg-secondary">
          Recovery checks this update on the host before continuing unfinished steps. Keep this
          window open until the host accepts the request; accepted recovery runs independently.
        </p>
      )}
      {operation.dispatched && !terminal && (
        <p className="text-xs text-fg-muted">
          The host accepted this operation. Status will refresh as it reconnects. Recovery actions
          are explicit; applying is never repeated automatically.
        </p>
      )}
    </div>
  );
}
