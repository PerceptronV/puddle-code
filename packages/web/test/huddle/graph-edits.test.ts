import { expect, it } from 'vitest';
import { huddleDefinitionSchema } from '@puddle/shared';
import { addGraphNode, removeGraphNode } from '../../src/features/huddle/documents/graph-edits';

it('adds stable distinct node ids and removes only the selected node and its incident edges', () => {
  const blank = huddleDefinitionSchema.parse({
    format: 1,
    id: 'a'.repeat(32),
    name: 'Review',
    nodes: [],
    edges: [],
  });
  const source = { kind: 'builtin' as const, component: 'puddle.trigger.manual', version: 1 };
  const one = addGraphNode(blank, source, 'run');
  const two = addGraphNode(one, source, 'run');
  const three = addGraphNode(two, source, 'run');
  expect(three.nodes.map((node) => node.id)).toEqual(['run', 'run-2', 'run-3']);
  const graph = {
    ...three,
    edges: [
      { id: 'first', from: { node: 'run', port: 'event' }, to: { node: 'run-2', port: 'input' } },
      {
        id: 'second',
        from: { node: 'run-2', port: 'event' },
        to: { node: 'run-3', port: 'input' },
      },
      { id: 'third', from: { node: 'run', port: 'event' }, to: { node: 'run-3', port: 'input' } },
    ],
  };
  const result = removeGraphNode(graph, 'run-2');
  expect(result.edges.map((edge) => edge.id)).toEqual(['third']);
  expect(result.nodes.map((node) => node.id)).toEqual(['run', 'run-3']);
  expect(graph.nodes).toHaveLength(3);
  expect(blank.nodes).toEqual([]);
});
