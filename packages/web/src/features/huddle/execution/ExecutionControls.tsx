import { TriggerDialog } from './triggers/TriggerDialog';
import { AutoStartControl } from './AutoStartControl';
import { useRetainedHistorySupported } from './history/api';
import { RecordedHistoryDialog } from './history/RecordedHistoryDialog';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { HuddleCommandTarget, Session } from '@puddle/shared';
import { ControlTray } from '../../../components/ui/control-tray';
import { useHuddleSourceDirty } from '../documents/use-source-dirty';
import { useHuddleAvailability, useHuddleDocument } from '../documents/queries';
import { graphActionClass } from '../inspector/GraphEditing';
import { huddleHistory, type HuddleCommand } from './api';
import { CommandDialog, type CommandReview } from './CommandDialog';
import { HistoryDialog } from './HistoryDialog';
import { TriggerHealth } from './TriggerHealth';
import { reviewHuddleRevision, useHuddleReviewSupported } from './review/api';
import { RevisionDialog } from './review/RevisionDialog';
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
  const retainedSupported = useRetainedHistorySupported();
  const [recordedHistory, setRecordedHistory] = useState(false);
  const [triggerTarget, setTriggerTarget] = useState<HuddleCommandTarget | null>(null);
  const reviewSupported = useHuddleReviewSupported();
  const runtime = useHuddleRuntime(profile, session.id, focused);
  const source = useHuddleDocument(profile, session);
  const commands = useHuddleCommands(profile, session.id);
  const cache = useQueryClient();
  const [review, setReview] = useState<CommandReview | null>(null);
  const [revisionTarget, setRevisionTarget] = useState<HuddleCommandTarget | null>(null);
  const [history, setHistory] = useState<{
    owner: ReturnType<typeof ownerIdentity>;
    execution?: string;
  } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const dirty = useHuddleSourceDirty(session);
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
      } else if (active?.connected) {
        const comparison =
          kind === 'apply' && reviewSupported && document
            ? await reviewHuddleRevision(profile, session.id, {
                target: active.target,
                expected_digest: document.digest,
              })
            : undefined;
        setReview({ kind, document, target: active.target, ...(comparison ? { comparison } : {}) });
      }
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
      if (!observed) throw new Error('Runtime outcome is still unavailable');
      if (observed.unresolved || observed.owner?.connected === false) {
        if (!observed.recovery) throw new Error('Runtime outcome is still unavailable');
        // Observation may unlock a fresh explicit recovery request. The server still
        // requires the exact predecessor and rejects any consumed recovery attempt.
        commands.reviewed();
        return;
      }
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
          {runtime.data?.recovery && (
            <button
              type="button"
              className={graphActionClass}
              title="Restore the last active graph and retained trigger cursors after a host reboot. Running scripts remain interrupted."
              disabled={busy || commands.status.review || session.status === 'archived' || locked}
              onClick={() =>
                void send({
                  action: 'recover',
                  input: { owner: runtime.data!.recovery!.owner },
                }).catch(() => {})
              }
            >
              Recover after reboot
            </button>
          )}
          {!owner && !runtime.data?.recovery && (
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
              {reviewSupported && (
                <button
                  type="button"
                  className={graphActionClass}
                  disabled={busy || !current.target.activationId}
                  onClick={() => setRevisionTarget(current.target)}
                >
                  Active revision
                </button>
              )}
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
          {current?.trigger_inspection && (
            <button
              type="button"
              className={graphActionClass}
              onClick={() => setTriggerTarget(current.target)}
            >
              Triggers
            </button>
          )}
          {(current || retainedSupported) && (
            <button
              type="button"
              className={graphActionClass}
              disabled={busy}
              onClick={() =>
                current
                  ? setHistory({ owner: ownerIdentity(current.target) })
                  : setRecordedHistory(true)
              }
            >
              History
            </button>
          )}
        </ControlTray>
        {current && current.auto_start !== undefined && (
          <AutoStartControl
            enabled={current.auto_start}
            target={current.target}
            disabled={!canAct || session.status === 'archived' || locked}
            send={send}
          />
        )}
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
      {current?.custom_triggers && !current.trigger_inspection && (
        <TriggerHealth sources={current.custom_triggers} />
      )}
      {triggerTarget && (
        <TriggerDialog
          profile={profile}
          session={session.id}
          target={triggerTarget}
          focused={focused}
          stale={unavailable || !current || !sameTarget(current.target, triggerTarget)}
          onClose={() => setTriggerTarget(null)}
        />
      )}
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
          profile={profile}
          session={session.id}
          worktree={session.worktree_path}
          blocked={blocked}
          pending={commands.status.pending}
          error={commands.status.error}
          send={send}
          onClose={() => setReview(null)}
        />
      )}
      {revisionTarget && (
        <RevisionDialog
          profile={profile}
          session={session.id}
          target={revisionTarget}
          stale={unavailable || !current || !sameTarget(current.target, revisionTarget)}
          onClose={() => setRevisionTarget(null)}
        />
      )}
      {recordedHistory && (
        <RecordedHistoryDialog
          profile={profile}
          session={session.id}
          onClose={() => setRecordedHistory(false)}
        />
      )}
      {history && (
        <HistoryDialog
          profile={profile}
          session={session.id}
          owner={history.owner}
          initialExecution={history.execution}
          onRecordedRuntimes={
            retainedSupported
              ? () => {
                  setHistory(null);
                  setRecordedHistory(true);
                }
              : undefined
          }
          onClose={() => setHistory(null)}
        />
      )}
    </>
  );
}
