import { useId, useState, useRef, useLayoutEffect } from 'react';
import { FileCode } from 'lucide-react';
import {
  coreHuddleComponents,
  calendarDateHuddleTrigger,
  supportsApplicationFeature,
  huddleNodeTemplates,
  huddleNodeSchema,
  huddleRelativePathSchema,
  type Session,
} from '@puddle/shared';
import { Input } from '../../../../components/ui/input';
import { Label } from '../../../../components/ui/label';
import { useDaemonVersion } from '../../../../lib/queries/queries';
import { addGraphNode, nextGraphId } from '../../documents/graph-edits';
import { useHuddleTemplates } from '../../documents/templates';
import { nestedIsland } from '../../controls/HuddlePanel';
import { graphActionClass, type EditGraph } from '../GraphEditing';
import { nodeGroups, cataloguePresentation } from './groups';

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
    <div className="flex flex-col gap-3" aria-label="Add node">
      <div className="sticky top-0 z-10 flex flex-col gap-3 bg-elevated pb-3">
        <Label htmlFor={`${id}-search`}>Find a node</Label>
        <Input
          id={`${id}-search`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search nodes"
        />
      </div>
      {nodeGroups.map((group) => {
        const entries = [
          ...[...coreHuddleComponents.values()]
            .filter(
              (component) =>
                component.id !== calendarDateHuddleTrigger.id ||
                supportsApplicationFeature(protocol, { major: 28, minor: 28 }),
            )
            .map((component) => ({
              component,
              disabled: false,
              add: () =>
                edit((graph) =>
                  addGraphNode(
                    graph,
                    { kind: 'builtin', component: component.id, version: component.version },
                    component.id.endsWith('.manual') ? 'run' : component.id.split('.').at(-1)!,
                    cataloguePresentation(component).appearance,
                  ),
                ),
            })),
          ...(template.supported
            ? huddleNodeTemplates
                .filter((item) => template.supportsTemplate(item.template))
                .map((item) => ({
                  component: item.component,
                  disabled: template.isPending,
                  add: () => {
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
                                appearance: cataloguePresentation(item.component).appearance,
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
                  },
                }))
            : []),
        ].filter(
          ({ component }) =>
            cataloguePresentation(component).group === group.id &&
            `${group.title} ${component.title} ${component.category}`
              .toLowerCase()
              .includes(search.toLowerCase()),
        );
        if (!entries.length) return null;
        return (
          <section
            key={group.id}
            className={`${nestedIsland} flex flex-col gap-1`}
            aria-label={group.title}
          >
            <h3 className={`px-2 pb-2 text-xs font-medium ${group.colour}`}>{group.title}</h3>
            {entries.map(({ component, disabled, add }) => {
              const { Icon } = cataloguePresentation(component);
              return (
                <button
                  key={component.id}
                  type="button"
                  aria-label={`Add ${component.title}`}
                  className={`${graphActionClass} flex items-center gap-3 text-left`}
                  disabled={disabled}
                  onClick={add}
                >
                  <Icon className={`size-4 shrink-0 ${group.colour}`} />
                  <span>{component.title}</span>
                </button>
              );
            })}
          </section>
        );
      })}
      {template.error && (
        <p className="text-xs text-fg-muted">
          {template.error.message}. Inspect the component files before trying again.
        </p>
      )}
      <section className={`${nestedIsland} flex flex-col gap-3`} aria-label="Custom nodes">
        <Label htmlFor={`${id}-local`}>Local component contract</Label>
        <Input
          id={`${id}-local`}
          value={manifest}
          onChange={(event) => setManifest(event.target.value)}
          placeholder="nodes/review/node.json"
        />
        <button
          type="button"
          className={`${graphActionClass} flex items-center gap-2`}
          disabled={!local.success}
          onClick={() => {
            if (local.success)
              edit((graph) =>
                addGraphNode(graph, { kind: 'local', manifest: local.data }, 'script', {
                  icon: 'file-code',
                  colour: 'violet',
                }),
              );
          }}
        >
          <FileCode className="size-4 text-icon-violet" /> Add local node
        </button>
        <p className="text-xs text-fg-muted">
          Paths are relative to this huddle directory. Node templates create editable source files.
        </p>
      </section>
    </div>
  );
}
