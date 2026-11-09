import { HuddleSelect } from '../controls/HuddleSelect';
import { nestedIsland } from '../controls/HuddlePanel';
import { useId, useState } from 'react';
import type { HuddleDefinition, HuddleDocument } from '@puddle/shared';
import { Label } from '../../../components/ui/label';
import { connectGraph } from '../documents/graph-connections';
import { Feedback } from './Feedback';

export const graphActionClass =
  'rounded-md px-2 py-1 text-xs text-fg hover:bg-elevated disabled:opacity-50';
export type EditGraph = (update: (graph: HuddleDefinition) => HuddleDefinition) => void;

export function Connections({ graph, edit }: { graph: HuddleDocument; edit: EditGraph }) {
  const id = useId();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const options = (direction: 'inputs' | 'outputs') =>
    graph.definition.nodes.flatMap((node) =>
      Object.keys(graph.components[node.id]?.[direction] ?? {}).map((port) => ({
        node: node.id,
        port,
      })),
    );
  const outputs = options('outputs');
  const inputs = options('inputs');
  const source = outputs.find((endpoint) => JSON.stringify(endpoint) === from);
  const target = inputs.find((endpoint) => JSON.stringify(endpoint) === to);
  return (
    <div className="flex flex-col gap-3" aria-label="Edit connections">
      <Label htmlFor={`${id}-output`}>Output</Label>
      <HuddleSelect
        id={`${id}-output`}
        value={source ? from : ''}
        onValueChange={setFrom}
        placeholder="Choose output"
        options={outputs.map((endpoint) => ({
          value: JSON.stringify(endpoint),
          label: `${endpoint.node}.${endpoint.port}`,
        }))}
      />
      <Label htmlFor={`${id}-input`}>Input</Label>
      <HuddleSelect
        id={`${id}-input`}
        value={target ? to : ''}
        onValueChange={setTo}
        placeholder="Choose input"
        options={inputs.map((endpoint) => ({
          value: JSON.stringify(endpoint),
          label: `${endpoint.node}.${endpoint.port}`,
        }))}
      />
      <button
        type="button"
        className={graphActionClass}
        disabled={!source || !target}
        onClick={() => {
          if (source && target)
            edit((definition) => connectGraph({ ...graph, definition }, source, target));
        }}
      >
        Connect
      </button>
      {graph.definition.edges.map((edge) => (
        <div key={edge.id} className={`${nestedIsland} flex flex-col gap-2 text-xs`}>
          <span className="min-w-0 flex-1 break-words">
            {edge.from.node}.{edge.from.port} → {edge.to.node}.{edge.to.port}
          </span>
          <Feedback
            edge={edge}
            schema={graph.components[edge.from.node]?.outputs[edge.from.port]?.schema}
            edit={edit}
          />
          <button
            type="button"
            className={graphActionClass}
            aria-label={`Disconnect ${edge.id}`}
            onClick={() =>
              edit((definition) => ({
                ...definition,
                edges: definition.edges.filter((item) => item.id !== edge.id),
              }))
            }
          >
            Disconnect
          </button>
        </div>
      ))}
    </div>
  );
}
