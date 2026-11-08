import { useId, useState } from 'react';
import {
  coreHuddleComponents,
  huddleRelativePathSchema,
  type HuddleDefinition,
  type HuddleDocument,
} from '@puddle/shared';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { addGraphNode, nextGraphId } from '../documents/graph-edits';

export const graphActionClass =
  'rounded-md px-2 py-1 text-xs text-fg hover:bg-elevated disabled:opacity-50';
export type EditGraph = (update: (graph: HuddleDefinition) => HuddleDefinition) => void;

/** The list alternative is also a keyboard/touch path to node and wire authoring. */
export function AddNode({ edit }: { edit: EditGraph }) {
  const id = useId();
  const [search, setSearch] = useState('');
  const [manifest, setManifest] = useState('');
  const local = huddleRelativePathSchema.safeParse(manifest);
  return (
    <div className="flex flex-col gap-3 p-4" aria-label="Add node">
      <Label htmlFor={`${id}-search`}>Find a node</Label>
      <Input
        id={`${id}-search`}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search nodes"
      />
      {[...coreHuddleComponents.values()]
        .filter((component) =>
          `${component.title} ${component.category}`.toLowerCase().includes(search.toLowerCase()),
        )
        .map((component) => (
          <button
            key={component.id}
            type="button"
            className={`${graphActionClass} text-left`}
            onClick={() =>
              edit((graph) =>
                addGraphNode(
                  graph,
                  { kind: 'builtin', component: component.id, version: component.version },
                  component.category === 'trigger' ? 'run' : 'result',
                ),
              )
            }
          >
            Add {component.title}
          </button>
        ))}
      <Label htmlFor={`${id}-local`}>Local component contract</Label>
      <Input
        id={`${id}-local`}
        value={manifest}
        onChange={(event) => setManifest(event.target.value)}
        placeholder="nodes/review/node.json"
      />
      <button
        type="button"
        className={graphActionClass}
        disabled={!local.success}
        onClick={() => {
          if (local.success)
            edit((graph) => addGraphNode(graph, { kind: 'local', manifest: local.data }, 'script'));
        }}
      >
        Add local node
      </button>
      <p className="text-xs text-fg-muted">
        Paths are relative to this huddle directory. Save and refresh to inspect a newly referenced
        contract.
      </p>
    </div>
  );
}

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
  const selectClass = 'min-w-0 rounded-md bg-surface px-2 py-1 text-sm text-fg';
  return (
    <div className="flex flex-col gap-3 p-4" aria-label="Edit connections">
      <Label htmlFor={`${id}-output`}>Output</Label>
      <select
        id={`${id}-output`}
        className={selectClass}
        value={source ? from : ''}
        onChange={(event) => setFrom(event.target.value)}
      >
        <option value="">Choose output</option>
        {outputs.map((endpoint) => (
          <option key={JSON.stringify(endpoint)} value={JSON.stringify(endpoint)}>
            {endpoint.node}.{endpoint.port}
          </option>
        ))}
      </select>
      <Label htmlFor={`${id}-input`}>Input</Label>
      <select
        id={`${id}-input`}
        className={selectClass}
        value={target ? to : ''}
        onChange={(event) => setTo(event.target.value)}
      >
        <option value="">Choose input</option>
        {inputs.map((endpoint) => (
          <option key={JSON.stringify(endpoint)} value={JSON.stringify(endpoint)}>
            {endpoint.node}.{endpoint.port}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={graphActionClass}
        disabled={!source || !target}
        onClick={() => {
          if (source && target)
            edit((definition) => ({
              ...definition,
              edges: [
                ...definition.edges,
                { id: nextGraphId(definition.edges, 'connection'), from: source, to: target },
              ],
            }));
        }}
      >
        Connect
      </button>
      {graph.definition.edges.map((edge) => (
        <div key={edge.id} className="flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 break-words">
            {edge.from.node}.{edge.from.port} → {edge.to.node}.{edge.to.port}
          </span>
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
