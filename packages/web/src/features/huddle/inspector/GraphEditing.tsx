import { useId, useState, useRef, useLayoutEffect } from 'react';
import {
  coreHuddleComponents,
  calendarDateHuddleTrigger,
  supportsApplicationFeature,
  huddleNodeTemplates,
  huddleNodeSchema,
  type Session,
  huddleRelativePathSchema,
  type HuddleDefinition,
  type HuddleDocument,
} from '@puddle/shared';
import { Input } from '../../../components/ui/input';
import { useDaemonVersion } from '../../../lib/queries/queries';
import { Label } from '../../../components/ui/label';
import { addGraphNode, nextGraphId } from '../documents/graph-edits';
import { useHuddleTemplates } from '../documents/templates';
import { connectGraph } from '../documents/graph-connections';
import { Feedback } from './Feedback';

export const graphActionClass =
  'rounded-md px-2 py-1 text-xs text-fg hover:bg-elevated disabled:opacity-50';
export type EditGraph = (update: (graph: HuddleDefinition) => HuddleDefinition) => void;

/** The list alternative is also a keyboard/touch path to node and wire authoring. */
export function AddNode({
  edit,
  profile,
  session,
}: {
  edit: EditGraph;
  profile?: string;
  session: Session;
}) {
  const id = useId();
  const [search, setSearch] = useState('');
  const [manifest, setManifest] = useState('');
  const local = huddleRelativePathSchema.safeParse(manifest);
  const template = useHuddleTemplates(profile, session);
  const protocol = useDaemonVersion().data?.protocol;
  const latestEdit = useRef(edit);
  useLayoutEffect(() => {
    latestEdit.current = edit;
  }, [edit]);
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
        .filter(
          (component) =>
            component.id !== calendarDateHuddleTrigger.id ||
            supportsApplicationFeature(protocol, { major: 28, minor: 28 }),
        )
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
                  component.id.split('.').at(-1) === 'manual'
                    ? 'run'
                    : component.id.split('.').at(-1)!,
                ),
              )
            }
          >
            Add {component.title}
          </button>
        ))}
      {template.supported &&
        huddleNodeTemplates
          .filter((item) => template.supportsTemplate(item.template))
          .filter(({ component }) =>
            `${component.title} ${component.category}`.toLowerCase().includes(search.toLowerCase()),
          )
          .map((item) => (
            <button
              type="button"
              key={item.template}
              className={`${graphActionClass} text-left`}
              disabled={template.isPending}
              onClick={() => {
                const component = `${item.template}-${crypto.randomUUID().replaceAll('-', '')}`;
                template.mutate(
                  { template: item.template, component },
                  {
                    onSuccess: (installed) => {
                      latestEdit.current((graph) => ({
                        ...graph,
                        nodes: [
                          ...graph.nodes,
                          huddleNodeSchema.parse({
                            id: nextGraphId(graph.nodes, item.template),
                            source: { kind: 'local', manifest: installed.manifest },
                            parameters: Object.fromEntries(
                              Object.entries(installed.component.parameters).flatMap(
                                ([name, parameter]) =>
                                  parameter.default === undefined
                                    ? []
                                    : [[name, { kind: 'literal', value: parameter.default }]],
                              ),
                            ),
                          }),
                        ],
                      }));
                    },
                  },
                );
              }}
            >
              Add {item.component.title}
            </button>
          ))}
      {template.error && (
        <p className="text-xs text-fg-muted">
          {template.error.message}. Inspect the component files before trying again.
        </p>
      )}
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
        Paths are relative to this huddle directory. Node templates create editable source files.
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
            edit((definition) => connectGraph({ ...graph, definition }, source, target));
        }}
      >
        Connect
      </button>
      {graph.definition.edges.map((edge) => (
        <div key={edge.id} className="flex flex-col gap-2 py-2 text-xs">
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
