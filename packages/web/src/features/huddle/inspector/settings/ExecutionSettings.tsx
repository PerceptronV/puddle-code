import { useId, useState } from 'react';
import {
  huddleDefinitionSchema,
  supportsApplicationFeature,
  type HuddleDefinition,
} from '@puddle/shared';
import { Input } from '../../../../components/ui/input';
import { Label } from '../../../../components/ui/label';
import { useDaemonVersion } from '../../../../lib/queries/queries';
import { graphActionClass, type EditGraph } from '../GraphEditing';

type Execution = HuddleDefinition['execution'];
const limits = [
  ['concurrency', 'Concurrent executions', 1, 16],
  ['maxTurns', 'Agent turns per execution', 1, 1000],
  ['maxAgents', 'Agent spawns per execution', 1, 32],
  ['maxInvocations', 'Node invocations per execution', 1, 4096],
  ['timeoutMs', 'Execution timeout (milliseconds)', 1000, 86_400_000],
  ['maxQueuedEvents', 'Queued events', 1, 4096],
  ['maxDailyExecutions', 'Executions per UTC day', 1, 10_000],
  ['maxDailyAgentSpawns', 'Agent spawns per UTC day', 1, 1000],
] as const;

export function ExecutionSettings({
  execution,
  edit,
  locked,
}: {
  execution: Execution;
  edit: EditGraph;
  locked: boolean;
}) {
  // Source edits and undo replace the form baseline, rather than leaving stale values to apply.
  return <SettingsForm key={JSON.stringify(execution)} {...{ execution, edit, locked }} />;
}

function SettingsForm({
  execution,
  edit,
  locked,
}: {
  execution: Execution;
  edit: EditGraph;
  locked: boolean;
}) {
  const id = useId();
  const admissionSupported = supportsApplicationFeature(useDaemonVersion().data?.protocol, {
    major: 28,
    minor: 29,
  });
  const [values, setValues] = useState(() =>
    Object.fromEntries(limits.map(([key]) => [key, String(execution[key])])),
  );
  const [queue, setQueue] = useState(execution.queue);
  const [cleanup, setCleanup] = useState(execution.cleanup);
  const parsed = huddleDefinitionSchema.shape.execution.safeParse({
    ...execution,
    ...Object.fromEntries(
      limits.map(([key]) => [key, values[key]?.trim() ? Number(values[key]) : NaN]),
    ),
    queue,
    cleanup,
  });
  const changed =
    limits.some(([key]) => values[key] !== String(execution[key])) ||
    queue !== execution.queue ||
    cleanup !== execution.cleanup;
  return (
    <form
      className="min-w-0 flex-1 p-4"
      aria-label="Execution settings"
      onSubmit={(event) => {
        event.preventDefault();
        if (locked || !parsed.success || !changed) return;
        edit((graph) => {
          if (JSON.stringify(graph.execution) !== JSON.stringify(execution))
            throw new Error('Execution settings changed. Review the current settings first.');
          return { ...graph, execution: parsed.data };
        });
      }}
    >
      <fieldset disabled={locked} className="flex flex-col gap-4">
        <legend className="mb-2 text-sm">Execution settings</legend>
        <p className="text-xs text-fg-muted">
          Update the draft, then Save. Start or Apply activates saved settings for new executions;
          accepted work keeps its original limits.
        </p>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-4">
          {limits.map(([key, label, min, max]) => (
            <div key={key} className="flex flex-col gap-2">
              <Label htmlFor={`${id}-${key}`}>{label}</Label>
              <Input
                id={`${id}-${key}`}
                type="number"
                required
                min={min}
                max={max}
                step={1}
                value={values[key]}
                onChange={(event) => setValues({ ...values, [key]: event.target.value })}
              />
            </div>
          ))}
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-queue`}>Default event admission</Label>
            <select
              id={`${id}-queue`}
              className="rounded-md bg-surface px-2 py-1 text-sm text-fg"
              value={queue}
              onChange={(event) => setQueue(event.target.value as Execution['queue'])}
            >
              <option value="queue">Queue</option>
              {admissionSupported && (
                <>
                  <option value="coalesce">Coalesce waiting events</option>
                  <option value="drop">Drop while busy</option>
                </>
              )}
              {!admissionSupported && execution.queue !== 'queue' && (
                <option value={execution.queue} disabled>
                  {execution.queue} · unavailable
                </option>
              )}
            </select>
            <p className="text-xs text-fg-muted">
              {admissionSupported
                ? 'Triggers inherit this policy unless overridden in their inspector. Coalesce replaces waiting work only; Drop skips busy sources or full queues. Running work is never interrupted.'
                : 'This host supports queued events only.'}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-cleanup`}>Owned agent cleanup</Label>
            <select
              id={`${id}-cleanup`}
              className="rounded-md bg-surface px-2 py-1 text-sm text-fg"
              value={cleanup}
              onChange={(event) => setCleanup(event.target.value as Execution['cleanup'])}
            >
              <option value="stop-owned">Stop owned agents</option>
              <option value="retain-owned">Keep owned agents</option>
            </select>
            <p className="text-xs text-fg-muted">
              On interruption, Stop or execution failure. Kept agents remain in ordinary session
              controls; attached agents keep their own lifecycle.
            </p>
          </div>
        </div>
        <button
          type="submit"
          className={`${graphActionClass} self-start`}
          disabled={!parsed.success || !changed}
        >
          Update execution draft
        </button>
      </fieldset>
    </form>
  );
}
