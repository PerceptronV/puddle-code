import { RetainedRevisionDialog } from './review/RetainedRevisionDialog';
import { useRetainedRevisionSupported } from './review/api';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  supportsApplicationFeature,
  type HuddleHistoryPage,
  type HuddleHistoryRequest,
} from '@puddle/shared';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '../../../components/ui/dialog';
import { ControlTray } from '../../../components/ui/control-tray';
import { Disclosure } from '../../../components/ui/disclosure';
import { huddleHistory } from './api';
import { huddleRetainedHistory } from './history/api';
import { historyKey, useHuddleRuntime, useHuddleCommands } from './queries';
import { useDaemonVersion } from '../../../lib/queries/queries';
import { ReadoutObservation } from './ReadoutObservation';
import { graphActionClass } from '../inspector/GraphEditing';
import { AgentLink } from './history/AgentLink';
import { TriggerInput } from './history/TriggerInput';

type Owner = HuddleHistoryRequest['owner'];
function usePage(profile: string, session: string, input: HuddleHistoryRequest, retained = false) {
  return useQuery<HuddleHistoryPage & { observedAt?: string }>({
    queryKey: [...historyKey(profile, session), ...(retained ? ['retained'] : []), input],
    queryFn: ({ signal }) =>
      retained
        ? huddleRetainedHistory(profile, session, input, signal).then((value) => ({
            ...value.history,
            observedAt: value.observed_at,
          }))
        : huddleHistory(profile, session, input, signal),
    retry: false,
    networkMode: 'always',
    staleTime: 0,
    refetchInterval: (query) => (retained || query.state.error ? false : 3000),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: !retained,
  });
}

export function HistoryDialog({
  profile,
  session,
  owner,
  initialExecution,
  retained = false,
  onRecordedRuntimes,
  onClose,
}: {
  profile: string;
  session: string;
  owner: Owner;
  initialExecution?: string;
  retained?: boolean;
  onRecordedRuntimes?(): void;
  onClose(): void;
}) {
  const revisionSupported = useRetainedRevisionSupported();
  const inputSupported = supportsApplicationFeature(useDaemonVersion().data?.protocol, {
    major: 28,
    minor: 33,
  });
  const [revision, setRevision] = useState<{ digest?: string } | null>(null);
  const [cursors, setCursors] = useState([0]);
  const [selected, select] = useState<string | null>(initialExecution ?? null);
  const after = cursors.at(-1)!;
  const page = usePage(profile, session, { owner, collection: 'executions', after }, retained);
  const data: Extract<HuddleHistoryPage, { collection: 'executions' }> | undefined =
    page.data?.collection === 'executions' ? page.data : undefined;
  const selectedRecord = data?.records.find(({ record }) => record.id === selected)?.record;
  if (revision)
    return (
      <RetainedRevisionDialog
        profile={profile}
        session={session}
        request={{ owner, ...(revision.digest ? { revision: revision.digest } : {}) }}
        onBack={() => setRevision(null)}
        onClose={onClose}
      />
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent wide>
        <DialogTitle>Huddle history</DialogTitle>
        <DialogDescription>
          {retained
            ? 'Recorded ledger history. Pending, running and unknown records do not establish current activity or completion. Nothing is restarted or reconciled.'
            : 'Execution acceptance and completion are separate. This view reads the connected runtime.'}
        </DialogDescription>
        <p className="break-all text-xs text-fg-muted">Runtime {owner.runtimeId}</p>
        {retained && page.data?.observedAt && (
          <p className="text-xs text-fg-muted">
            Read {new Date(page.data.observedAt).toLocaleString()}
          </p>
        )}
        <ControlTray label="History pages" className="w-fit">
          {onRecordedRuntimes && (
            <button type="button" className={graphActionClass} onClick={onRecordedRuntimes}>
              Recorded runtimes
            </button>
          )}
          {revisionSupported && (
            <button type="button" className={graphActionClass} onClick={() => setRevision({})}>
              Recorded activation
            </button>
          )}
          <button
            type="button"
            className={graphActionClass}
            disabled={page.isFetching}
            onClick={() => void page.refetch()}
          >
            Refresh executions
          </button>
          <button
            type="button"
            className={graphActionClass}
            disabled={cursors.length === 1 || page.isFetching}
            onClick={() => setCursors(cursors.slice(0, -1))}
          >
            Previous page
          </button>
          <button
            type="button"
            className={graphActionClass}
            disabled={!data?.records.length || data.next <= after || page.isFetching}
            onClick={() => setCursors([...cursors, data!.next])}
          >
            Next page
          </button>
        </ControlTray>
        {page.error && (
          <p role="alert" className="text-xs text-fg-muted">
            {page.error.message}
          </p>
        )}
        {page.isPending && <p className="text-xs text-fg-muted">Loading executions…</p>}
        {data?.records.length === 0 && (
          <p className="text-xs text-fg-muted">No executions on this page.</p>
        )}
        <div className="grid min-h-0 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div className="max-h-80 space-y-1 overflow-auto" aria-label="Executions">
            {data?.records.map(({ record }) => (
              <button
                type="button"
                key={record.id}
                aria-pressed={selected === record.id}
                onClick={() => select(record.id)}
                className={`${graphActionClass} flex w-full flex-col items-start gap-1 text-left aria-pressed:bg-explorer-selection`}
              >
                <span>
                  {record.state} · {record.id.slice(0, 8)}
                </span>
                <span className="text-fg-muted">
                  {new Date(record.acceptedAt).toLocaleString()}
                </span>
              </button>
            ))}
            <p className="pt-2 text-xs text-fg-muted">
              Earlier entries appear first. Refresh a page to see changed outcomes.
            </p>
          </div>
          {selected ? (
            <div className="min-w-0 space-y-3">
              <p className="break-all text-xs">Execution {selected}</p>
              {inputSupported && (
                <TriggerInput
                  key={`trigger-input:${selected}`}
                  profile={profile}
                  session={session}
                  request={{ owner, execution_id: selected }}
                />
              )}
              {selectedRecord && (
                <div className="space-y-1 text-xs text-fg-muted">
                  <p>
                    {selectedRecord.state} · revision {selectedRecord.revision.slice(0, 12)}
                  </p>
                  <p>
                    {selectedRecord.turns} turns · {selectedRecord.spawns} spawns ·{' '}
                    {selectedRecord.invocations} node invocations
                  </p>
                  {selectedRecord.error && <p role="alert">{selectedRecord.error}</p>}
                  {revisionSupported && (
                    <button
                      type="button"
                      className={graphActionClass}
                      onClick={() => setRevision({ digest: selectedRecord.revision })}
                    >
                      Execution source
                    </button>
                  )}
                </div>
              )}
              <ExecutionRecords
                key={selected}
                profile={profile}
                session={session}
                owner={owner}
                execution={selected}
                retained={retained}
                onOpenAgent={onClose}
              />
            </div>
          ) : (
            <p className="text-xs text-fg-muted">
              Choose an execution to inspect nodes and results.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ExecutionRecords({
  profile,
  session,
  owner,
  execution,
  retained,
  onOpenAgent,
}: {
  profile: string;
  session: string;
  owner: Owner;
  execution: string;
  retained: boolean;
  onOpenAgent(): void;
}) {
  const [collection, setCollection] = useState<'invocations' | 'operations'>('invocations');
  const [cursors, setCursors] = useState([0]);
  const after = cursors.at(-1)!;
  const protocol = useDaemonVersion().data?.protocol;
  const observationSupported = supportsApplicationFeature(protocol, {
    major: 28,
    minor: retained ? 21 : 6,
  });
  const page = usePage(
    profile,
    session,
    {
      owner,
      collection,
      after,
      parent: execution,
      ...(observationSupported ? { include_readout_observation: true as const } : {}),
      ...(supportsApplicationFeature(protocol, { major: 28, minor: 32 })
        ? { include_agent: true as const }
        : {}),
    },
    retained,
  );
  const runtime = useHuddleRuntime(profile, session, !retained);
  const commands = useHuddleCommands(profile, session);
  const current = runtime.data?.owner;
  const observationTarget =
    observationSupported &&
    !runtime.error &&
    current?.connected &&
    current.readout_observation &&
    !current.stopping &&
    !current.failure &&
    current.target.runtimeId === owner.runtimeId &&
    current.target.incarnation === owner.incarnation
      ? current.target
      : null;
  return (
    <>
      <ControlTray label="Execution detail" className="w-fit flex-wrap">
        {(['invocations', 'operations'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            className={graphActionClass}
            aria-pressed={collection === kind}
            onClick={() => {
              setCollection(kind);
              setCursors([0]);
            }}
          >
            {kind === 'invocations' ? 'Nodes' : 'Operations'}
          </button>
        ))}
        <button
          type="button"
          className={graphActionClass}
          disabled={cursors.length === 1 || page.isFetching}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          Previous details
        </button>
        <button
          type="button"
          className={graphActionClass}
          disabled={!page.data?.records.length || page.data.next <= after || page.isFetching}
          onClick={() => setCursors([...cursors, page.data!.next])}
        >
          Next details
        </button>
      </ControlTray>
      {page.error && (
        <p role="alert" className="text-xs text-fg-muted">
          {page.error.message}
        </p>
      )}
      {commands.status.review && (
        <button
          type="button"
          className={graphActionClass}
          disabled={page.isFetching || runtime.isFetching}
          onClick={() => {
            void Promise.all([page.refetch(), runtime.refetch()]).then(([history, state]) => {
              if (!history.error && !state.error) commands.reviewed();
            });
          }}
        >
          Inspect previous command
        </button>
      )}
      {page.data?.records.length === 0 && (
        <p className="text-xs text-fg-muted">No {collection} on this page.</p>
      )}
      <div className="max-h-80 space-y-3 overflow-auto">
        {page.data?.records.map(({ record }) => (
          <Disclosure
            key={record.id}
            className="text-xs"
            open
            summary={`${'node' in record ? record.node : 'kind' in record ? record.kind : record.id} · ${record.state}`}
            summaryClassName="py-1 text-fg"
          >
            {'error' in record && record.error && (
              <p className="py-1 text-fg-muted">{record.error}</p>
            )}
            {'inputs' in record && <Value label="Inputs" value={record.inputs} />}
            {'agent' in record && record.agent && (
              <AgentLink agent={record.agent} onOpen={onOpenAgent} />
            )}
            {'result' in record && record.result !== undefined && (
              <Value label="Result" value={record.result} />
            )}
            {'consumed' in record && (
              <p className="text-fg-muted">
                {record.consumed ? 'Dispatch consumed' : 'Not dispatched'}
              </p>
            )}
            {'readout_observation' in record &&
              record.readout_observation &&
              (observationTarget || (retained && observationSupported)) && (
                <ReadoutObservation
                  operation={record.id}
                  target={observationTarget ?? undefined}
                  owner={retained ? owner : undefined}
                  disabled={commands.status.pending || commands.status.review}
                  send={commands.send}
                  inspect={async () => {
                    if (retained) {
                      const history = await page.refetch();
                      if (history.error) throw history.error;
                      commands.reviewed();
                      return;
                    }
                    const [history, state] = await Promise.all([page.refetch(), runtime.refetch()]);
                    if (history.error) throw history.error;
                    if (state.error) throw state.error;
                  }}
                />
              )}
          </Disclosure>
        ))}
      </div>
    </>
  );
}
function Value({ label, value }: { label: string; value: unknown }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <div className="py-1">
      <p className="text-fg-muted">{label}</p>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words">
        {text.length > 16_384 ? `${text.slice(0, 16_384)}\n… Preview truncated` : text}
      </pre>
    </div>
  );
}
