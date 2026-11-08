import { useId, useState } from 'react';
import type { HuddleNodeDefinition } from '@puddle/shared';
import { Input } from '../../../../components/ui/input';
import { Label } from '../../../../components/ui/label';
import { graphActionClass, type EditGraph } from '../GraphEditing';

export function NodeConcurrency({
  node,
  edit,
  locked,
}: {
  node: HuddleNodeDefinition;
  edit: EditGraph;
  locked: boolean;
}) {
  const id = useId();
  const [value, setValue] = useState(String(node.concurrency));
  const concurrency = Number(value);
  const valid = Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 32;
  return (
    <fieldset className="my-4 flex flex-col gap-2" disabled={locked}>
      <Label htmlFor={id}>Concurrent node invocations</Label>
      <Input
        id={id}
        type="number"
        min={1}
        max={32}
        step={1}
        required
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button
        type="button"
        className={graphActionClass}
        disabled={!valid || concurrency === node.concurrency}
        onClick={() =>
          edit((graph) => ({
            ...graph,
            nodes: graph.nodes.map((item) =>
              item.id === node.id ? { ...item, concurrency } : item,
            ),
          }))
        }
      >
        Update node draft
      </button>
    </fieldset>
  );
}
