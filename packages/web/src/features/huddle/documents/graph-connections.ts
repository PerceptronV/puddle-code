import { huddlePortCompatibility, type HuddleDocument, type HuddleEdge } from '@puddle/shared';
import { nextGraphId } from './graph-edits';

export type Endpoint = HuddleEdge['from'];
export function connectionProblem(graph: HuddleDocument, from: Endpoint, to: Endpoint) {
  const source = graph.components[from.node]?.outputs[from.port];
  const target = graph.components[to.node]?.inputs[to.port];
  if (!graph.definition.nodes.some((node) => node.id === from.node) || !source)
    return 'The output no longer exists.';
  if (!graph.definition.nodes.some((node) => node.id === to.node) || !target)
    return 'The input no longer exists.';
  if (
    graph.definition.edges.some(
      (edge) =>
        edge.from.node === from.node &&
        edge.from.port === from.port &&
        edge.to.node === to.node &&
        edge.to.port === to.port,
    )
  )
    return 'This connection already exists.';
  if (huddlePortCompatibility(source.schema, target.schema) === 'incompatible')
    return 'These ports have incompatible types.';
  // Cycles and ambiguous joins remain editable drafts. Validation explains them;
  // the connection inspector can add an explicit bounded feedback policy.
  return undefined;
}

export function connectGraph(graph: HuddleDocument, from: Endpoint, to: Endpoint) {
  const problem = connectionProblem(graph, from, to);
  if (problem) throw new Error(problem);
  return {
    ...graph.definition,
    edges: [
      ...graph.definition.edges,
      {
        id: nextGraphId(graph.definition.edges, 'connection'),
        from,
        to,
      },
    ],
  };
}
