import {
  Info,
  CirclePlay,
  GitCompareArrows,
  History,
  Pause,
  Play,
  RotateCcw,
  Square,
  Upload,
  Zap,
} from 'lucide-react';
import { HuddleAction } from '../controls/HuddleAction';
import { TriggerDialog } from './triggers/TriggerDialog';
import { AutoStartControl } from './AutoStartControl';
import { useRetainedHistorySupported } from './history/api';
import { RecordedHistoryDialog } from './history/RecordedHistoryDialog';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  manualHuddleTrigger,
  huddleHostTrigger,
  type HuddleCommandTarget,
  type Session,
} from '@puddle/shared';
import { ControlTray } from '../../../components/ui/control-tray';
import { useHuddleSourceDirty } from '../documents/use-source-dirty';
import { useHuddleAvailability, useHuddleDocument } from '../documents/queries';
import { huddleHistory } from './api';
import type { HuddleExecutionCommand } from './start-and-run';
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
    canAct && !owner && availability.data?.available && session.status !== 'archived';
  const canApply = canAct && !!current && session.status !== 'archived';
  const prepare = async (kind: CommandReview['kind']) => {
    if (!canAct) return;
    if (kind !== 'run' && (dirty || locked)) {
      toast.warning('Save or resolve source edits before Start or Apply.');
      return;
    }
    const starting = kind === 'start' || kind === 'start-and-run';
    setPreparing(true);
    try {
      const observed = await runtime.refetch({ throwOnError: true });
      const active = observed.data?.owner;
      if (!observed.data || observed.data.unresolved || active?.connected === false)
        throw new Error('Runtime observation is unavailable');
      if (starting && active)
        throw new Error('An owner already exists; inspect it before starting');
      if (!starting && (!active?.connected || active.stopping))
        throw new Error('No available owner to control');
      let document = source.data;
      if (kind !== 'run') document = (await source.refetch({ throwOnError: true })).data;
      if (kind === 'start' || kind === 'start-and-run') {
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
  const send = async (command: HuddleExecutionCommand) => {
    const response = await commands.send(command).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Huddle command failed', {
        description: 'The command was not repeated. Inspect the outcome before another action.',
      });
      throw error;
    });
    setReview(null);
    if (response.action === 'run')
      setHistory({
        owner: ownerIdentity(response.target),
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
      if (observed.owner?.failure) toast.warning(observed.owner.failure);
      else if (!observed.owner && availability.data?.available === false)
        toast.warning(availability.data.reason);
      else
        toast.info(status, {
          description:
            observed.owner?.lifetime === 'host_session'
              ? 'Runtime lifetime is limited to this host session.'
              : undefined,
        });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Cannot inspect outcome');
    } finally {
      setPreparing(false);
    }
  };
  let blocked: string | null = commands.status.review
    ? 'Close this review and inspect the previous outcome before another action.'
    : null;
  if (review && !blocked && !commands.status.pending) {
    if (runtime.isError || !runtime.data || runtime.data.unresolved || owner?.connected === false)
      blocked = 'Runtime observation is unavailable. Close and inspect again.';
    else if (
      review.kind === 'start' || review.kind === 'start-and-run'
        ? !!owner
        : !current || !sameTarget(current.target, review.target)
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
        className="pointer-events-auto ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-3"
        aria-label="Huddle execution"
      >
        <ControlTray
          label="Huddle execution actions"
          variant="island"
          className="max-w-full flex-wrap"
        >
          <span className="sr-only" role="status">
            {status}
          </span>
          {runtime.data?.recovery && (
            <HuddleAction
              icon={RotateCcw}
              label="Recover after reboot"
              title="Restore the last active graph and retained trigger cursors after a host reboot. Running scripts remain interrupted."
              disabled={busy || commands.status.review || session.status === 'archived' || locked}
              onClick={() =>
                void send({
                  action: 'recover',
                  input: { owner: runtime.data!.recovery!.owner },
                }).catch(() => {})
              }
            />
          )}
          {runtime.data?.recovery?.crash_recovery && (
            <HuddleAction
              icon={RotateCcw}
              label="Recover after crash"
              title="Recover a crashed owner after its recorded kernel scope confirms that script descendants have stopped. Queued events resume; interrupted scripts are not replayed."
              disabled={busy || commands.status.review || session.status === 'archived' || locked}
              onClick={() =>
                void send({
                  action: 'recover',
                  input: { owner: runtime.data!.recovery!.owner, after: 'owner-crash' },
                }).catch(() => {})
              }
            />
          )}
          {!owner && !runtime.data?.recovery && (
            <>
              <HuddleAction
                icon={Play}
                label="Start"
                disabled={!canStart}
                onClick={() => void prepare('start')}
              />
              {reviewSupported &&
                source.data?.definition.nodes.some(
                  (node) =>
                    huddleHostTrigger(node, source.data?.components[node.id])?.id ===
                    manualHuddleTrigger.id,
                ) && (
                  <HuddleAction
                    icon={CirclePlay}
                    label="Start and run"
                    disabled={!canStart}
                    onClick={() => void prepare('start-and-run')}
                  />
                )}
            </>
          )}
          {current && (
            <>
              {reviewSupported && (
                <HuddleAction
                  icon={GitCompareArrows}
                  label="Active revision"
                  disabled={busy || !current.target.activationId}
                  onClick={() => setRevisionTarget(current.target)}
                />
              )}
              <HuddleAction
                icon={Upload}
                label="Apply saved"
                disabled={!canApply}
                onClick={() => void prepare('apply')}
              />
              {current.lifecycle === 'armed' ? (
                <>
                  <HuddleAction
                    icon={Play}
                    label="Run"
                    disabled={!canAct}
                    onClick={() => void prepare('run')}
                  />
                </>
              ) : (
                <HuddleAction
                  icon={Play}
                  label="Resume"
                  disabled={!canAct}
                  onClick={() =>
                    void send({ action: 'rearm', input: { target: current.target } }).catch(
                      () => {},
                    )
                  }
                />
              )}
              <HuddleAction
                icon={Square}
                label="Stop"
                disabled={!canAct}
                onClick={() =>
                  void send({ action: 'stop', input: { target: current.target } }).catch(() => {})
                }
              />
            </>
          )}
          <HuddleAction
            icon={Pause}
            label="Interrupt"
            disabled={!canAct || current?.lifecycle !== 'armed'}
            onClick={() => {
              if (current?.lifecycle === 'armed')
                void send({ action: 'interrupt', input: { target: current.target } }).catch(
                  () => {},
                );
            }}
          />
          <HuddleAction
            title={`${status}${current?.failure ? ` · ${current.failure}` : ''}`}
            icon={Info}
            label={commands.status.review ? 'Inspect outcome' : 'Inspect runtime'}

            disabled={busy || runtime.isFetching}
            onClick={() => void inspectOutcome()}
          />
          {current?.trigger_inspection && (
            <HuddleAction
              icon={Zap}
              label="Triggers"
              onClick={() => setTriggerTarget(current.target)}
            />
          )}
          {(current || retainedSupported) && (
            <HuddleAction
              icon={History}
              label="History"
              disabled={busy}
              onClick={() =>
                current
                  ? setHistory({ owner: ownerIdentity(current.target) })
                  : setRecordedHistory(true)
              }
            />
          )}
          {current && current.auto_start !== undefined && (
            <AutoStartControl
              enabled={current.auto_start}
              target={current.target}
              disabled={!canAct || session.status === 'archived' || locked}
              send={send}
            />
          )}
        </ControlTray>
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
