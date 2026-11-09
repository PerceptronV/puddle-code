import { useId, useState } from 'react';
import {
  huddleTriggerAdmissionSchema,
  supportsApplicationFeature,
  type HuddleDefinition,
} from '@puddle/shared';
import { Input } from '../../../../components/ui/input';
import { Label } from '../../../../components/ui/label';
import { useDaemonVersion } from '../../../../lib/queries/queries';
import { graphActionClass, type EditGraph } from '../GraphEditing';

export function TriggerAdmission({
  node,
  execution,
  edit,
  locked,
}: {
  node: string;
  execution: HuddleDefinition['execution'];
  edit: EditGraph;
  locked: boolean;
}) {
  const supported = supportsApplicationFeature(useDaemonVersion().data?.protocol, {
    major: 28,
    minor: 29,
  });
  const id = useId();
  const current = execution.triggerAdmission?.[node];
  const [policy, setPolicy] = useState(current?.policy ?? 'inherit');
  const [limit, setLimit] = useState(String(current?.maxQueuedEvents ?? execution.maxQueuedEvents));
  const parsed = huddleTriggerAdmissionSchema.safeParse({ policy, maxQueuedEvents: Number(limit) });
  const changed =
    policy === 'inherit'
      ? !!current
      : parsed.success &&
        (parsed.data.policy !== current?.policy ||
          parsed.data.maxQueuedEvents !== current?.maxQueuedEvents);
  return (
    <fieldset className="my-4 flex flex-col gap-2" disabled={locked || !supported}>
      <legend className="mb-2 text-xs">Trigger admission</legend>
      <Label htmlFor={`${id}-policy`}>Event policy</Label>
      <select
        id={`${id}-policy`}
        className="rounded-md bg-surface px-2 py-1 text-sm text-fg"
        value={policy}
        onChange={(event) => setPolicy(event.target.value)}
      >
        <option value="inherit">Inherit ({execution.queue})</option>
        <option value="queue">Queue</option>
        <option value="coalesce">Coalesce waiting events</option>
        <option value="drop">Drop while busy</option>
      </select>
      {policy !== 'inherit' && (
        <>
          <Label htmlFor={`${id}-limit`}>Queued events for this trigger</Label>
          <Input
            id={`${id}-limit`}
            type="number"
            min={1}
            max={4096}
            step={1}
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
          />
        </>
      )}
      <p className="text-xs text-fg-muted">
        {supported
          ? 'Coalesce keeps the latest waiting input for each port in the same activation. Drop records skipped events while this trigger is busy or its queue is full. Graph queue limits also apply. Running work is never interrupted.'
          : 'Per-trigger admission settings require a newer host.'}
      </p>
      <button
        type="button"
        className={graphActionClass}
        disabled={!changed || (policy !== 'inherit' && !parsed.success)}
        onClick={() =>
          edit((graph) => {
            const { triggerAdmission, ...rest } = graph.execution;
            const overrides = { ...triggerAdmission };
            if (policy === 'inherit') delete overrides[node];
            else if (parsed.success) overrides[node] = parsed.data;
            return {
              ...graph,
              execution: {
                ...rest,
                ...(Object.keys(overrides).length ? { triggerAdmission: overrides } : {}),
              },
            };
          })
        }
      >
        Update trigger draft
      </button>
    </fieldset>
  );
}
