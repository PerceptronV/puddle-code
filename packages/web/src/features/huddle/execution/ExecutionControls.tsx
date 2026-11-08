import { useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { HuddleCommandTarget, Session } from '@puddle/shared';
import { ControlTray } from '../../../components/ui/control-tray';
import { bufferKey, listDirty, subscribeAny } from '../../editor/buffers/buffer-store';
import { useHuddleAvailability, useHuddleDocument } from '../documents/queries';
import { graphActionClass } from '../inspector/GraphEditing';
import { huddleHistory, type HuddleCommand } from './api';
import { CommandDialog, type CommandReview } from './CommandDialog';
import { HistoryDialog } from './HistoryDialog';
import {
  historyKey,
  useHuddleCommands,
  useHuddleExecutionSupported,
  useHuddleRuntime,
} from './queries';

function sameTarget(a: HuddleCommandTarget, b: HuddleCommandTarget) {
  return (
    a.runtimeId === b.runtimeId &&
    a.incarnation === b.incarnation &&
    a.generation === b.generation &&
    a.activationId === b.activationId
  );
}
const ownerIdentity = (target: HuddleCommandTarget) => ({
  runtimeId: target.runtimeId,
  incarnation: target.incarnation,
});

export function ExecutionControls({
  profile,
  session,
  focused,
  locked,
}: {
  profile: string;
  session: Session;
  focused: boolean;
  locked: boolean;
}) {
  const supported = useHuddleExecutionSupported();
  const runtime = useHuddleRuntime(profile, session.id, focused);
  const source = useHuddleDocument(profile, session);
  const commands = useHuddleCommands(profile, session.id);
  const cache = useQueryClient();
  const [review, setReview] = useState<CommandReview | null>(null);
  const [history, setHistory] = useState<{
    owner: ReturnType<typeof ownerIdentity>;
    execution?: string;
  } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const prefix = bufferKey(session.id, `.puddle/huddle/${session.huddle_id}/`);
  const dirty = useSyncExternalStore(
    subscribeAny,
    () => listDirty().some((key) => key.startsWith(prefix) && key.split(':').length === 2),
    () => false,
  );
  const owner = runtime.data?.owner;
  const current = owner?.connected ? owner : null;
  const availability = useHuddleAvailability(profile, supported && focused && !owner);
  if (!supported) return null;
  const busy = commands.status.pending || preparing;
  const unavailable =
    !runtime.data || runtime.isError || runtime.data.unresolved || owner?.connected === false;
  const canAct = !busy && !commands.status.review && !unavailable && !current?.stopping;
  const canStart =
    canAct &&
    !owner &&
    availability.data?.available &&
    !dirty &&
    !locked &&
    session.status !== 'archived';
  const canApply = canAct && !!current && !dirty && !locked && session.status !== 'archived';
  const prepare = async (kind: 'start' | 'apply' | 'run') => {
    if (!canAct) return;
    setPreparing(true);
    try {
      const observed = await runtime.refetch({ throwOnError: true });
      const active = observed.data?.owner;
      if (!observed.data || observed.data.unresolved || active?.connected === false)
        throw new Error('Runtime observation is unavailable');
      if (kind === 'start' && active)
        throw new Error('An owner already exists; inspect it before starting');
      if (kind !== 'start' && (!active?.connected || active.stopping))
        throw new Error('No available owner to control');
      let document = source.data;
      if (kind !== 'run') document = (await source.refetch({ throwOnError: true })).data;
      if (kind === 'start') {
        if (!document) throw new Error('Saved source is unavailable');
        setReview({ kind, document });
      } else if (active?.connected) setReview({ kind, document, target: active.target });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Cannot inspect huddle');
    } finally {
      setPreparing(false);
    }
  };
  const send = async (command: HuddleCommand) => {
    const response = await commands.send(command);
    setReview(null);
    if (response.action === 'run' && command.action === 'run')
      setHistory({
        owner: ownerIdentity(command.input.target),
        execution: response.value.executionId,
      });
  };
  const inspectOutcome = async () => {
    if (busy) return;
    setPreparing(true);
    try {
      const observed = (await runtime.refetch({ throwOnError: true })).data;
      if (!observed || observed.unresolved || observed.owner?.connected === false)
        throw new Error('Runtime outcome is still unavailable');
      if (observed.owner?.connected) {
        const identity = ownerIdentity(observed.owner.target);
        const input = { owner: identity, collection: 'executions' as const, after: 0 };
        const page = await huddleHistory(profile, session.id, input);
        cache.setQueryData([...historyKey(profile, session.id), input], page);
        if (commands.status.review) setHistory({ owner: identity });
      } else await availability.refetch();
      commands.reviewed();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Cannot inspect outcome');
    } finally {
      setPreparing(false);
    }
  };
  let blocked: string | null = commands.status.review
    ? 'Close this review and inspect the previous outcome before another action.'
    : null;
  if (review && !blocked) {
    if (runtime.isError || !runtime.data || runtime.data.unresolved || owner?.connected === false)
      blocked = 'Runtime observation is unavailable. Close and inspect again.';
    else if (
      review.kind === 'start' ? !!owner : !current || !sameTarget(current.target, review.target)
    )
      blocked = 'The active graph changed. Close and inspect again.';
    else if (review.kind !== 'run' && (dirty || locked))
      blocked = 'Save or resolve the source edits before continuing.';
  }
  const status = busy
    ? 'Working…'
    : unavailable
      ? 'Runtime unavailable'
      : !current
        ? 'Stopped'
        : current.stopping
          ? 'Stopping'
          : current.executing
            ? 'Executing'
            : current.lifecycle === 'armed'
              ? 'Armed · idle'
              : current.lifecycle === 'interrupted'
                ? 'Interrupted'
                : 'Ready to start';
  return (
    <>
      <div
        className="flex shrink-0 flex-wrap items-center gap-3 px-4 py-2"
        aria-label="Huddle execution"
      >
        <span className="text-xs text-fg-muted" role="status">
          {status}
        </span>
        <ControlTray label="Huddle execution actions" className="max-w-full flex-wrap">
          {!owner && (
            <button
              type="button"
              className={graphActionClass}
              disabled={!canStart}
              onClick={() => void prepare('start')}
            >
              Start
            </button>
          )}
          {current && (
            <>
              <button
                type="button"
                className={graphActionClass}
                disabled={!canApply}
                onClick={() => void prepare('apply')}
              >
                Apply saved
              </button>
              {current.lifecycle === 'armed' ? (
                <>
                  <button
                    type="button"
                    className={graphActionClass}
                    disabled={!canAct}
                    onClick={() => void prepare('run')}
                  >
                    Run
                  </button>
                  <button
                    type="button"
                    className={graphActionClass}
                    disabled={!canAct}
                    onClick={() =>
                      void send({ action: 'interrupt', input: { target: current.target } }).catch(
                        () => {},
                      )
                    }
                  >
                    Interrupt
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={graphActionClass}
                  disabled={!canAct}
                  onClick={() =>
                    void send({ action: 'rearm', input: { target: current.target } }).catch(
                      () => {},
                    )
                  }
                >
                  Resume
                </button>
              )}
              <button
                type="button"
                className={graphActionClass}
                disabled={!canAct}
                onClick={() =>
                  void send({ action: 'stop', input: { target: current.target } }).catch(() => {})
                }
              >
                Stop
              </button>
              <button
                type="button"
                className={graphActionClass}
                onClick={() => setHistory({ owner: ownerIdentity(current.target) })}
              >
                History
              </button>
            </>
          )}
          <button
            type="button"
            className={graphActionClass}
            disabled={busy || runtime.isFetching}
            onClick={() => void inspectOutcome()}
          >
            {commands.status.review ? 'Inspect outcome' : 'Inspect runtime'}
          </button>
        </ControlTray>
        {dirty && (
          <span className="text-xs text-fg-muted">Save source edits before Start or Apply.</span>
        )}
        {!owner && availability.data?.available === false && (
          <span className="text-xs text-fg-muted">{availability.data.reason}</span>
        )}
        {(current?.lifetime === 'host_session' ||
          (!owner &&
            availability.data?.available &&
            availability.data.lifetime === 'host_session')) && (
          <span className="text-xs text-fg-muted">
            Runtime lifetime is limited to this host session.
          </span>
        )}
      </div>
      {(runtime.error || commands.status.error || current?.failure) && (
        <p role="alert" className="shrink-0 px-4 pb-2 text-xs text-fg-muted">
          {runtime.error?.message ?? commands.status.error ?? current?.failure}
          {commands.status.error &&
            ' The command was not repeated. Inspect executions before sending another input.'}
        </p>
      )}
      {review && (
        <CommandDialog
          review={review}
          worktree={session.worktree_path}
          blocked={blocked}
          pending={commands.status.pending}
          error={commands.status.error}
          send={send}
          onClose={() => setReview(null)}
        />
      )}
      {history && (
        <HistoryDialog
          profile={profile}
          session={session.id}
          owner={history.owner}
          initialExecution={history.execution}
          onClose={() => setHistory(null)}
        />
      )}
    </>
  );
}
