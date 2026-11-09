import { huddleNodeSchema, type HuddleDefinition, type HuddleNodeDefinition } from '@puddle/shared';

export function nextGraphId(used: readonly { id: string }[], base: string): string {
  const ids = new Set(used.map((item) => item.id));
  if (!ids.has(base)) return base;
  for (let suffix = 2; ; suffix++) if (!ids.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
}

export function addGraphNode(
  graph: HuddleDefinition,
  source: HuddleNodeDefinition['source'],
  base: string,
) {
  const node = huddleNodeSchema.parse({ id: nextGraphId(graph.nodes, base), source });
  return { ...graph, nodes: [...graph.nodes, node] };
}

/** Removing a node also removes its connections; source component files stay intact. */
export function removeGraphNode(graph: HuddleDefinition, id: string): HuddleDefinition {
  const { triggerAdmission, ...execution } = graph.execution;
  const overrides = { ...triggerAdmission };
  delete overrides[id];
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => node.id !== id),
    edges: graph.edges.filter((edge) => edge.from.node !== id && edge.to.node !== id),
    execution: {
      ...execution,
      ...(Object.keys(overrides).length ? { triggerAdmission: overrides } : {}),
    },
  };
}
