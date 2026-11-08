import { expect, it } from 'vitest';
import { huddleDocumentSchema, huddleComponentSchema, validateHuddleGraph } from '@puddle/shared';
import {
  connectGraph,
  connectionProblem,
} from '../../src/features/huddle/documents/graph-connections';

function document() {
  const component = huddleComponentSchema.parse({
    format: 1,
    id: 'example.agent',
    version: 1,
    category: 'script',
    title: 'Agent',
    entry: 'run.ts',
    inputs: { message: { schema: {} } },
    outputs: { reply: { schema: { type: 'string' } } },
  });
  return huddleDocumentSchema.parse({
    digest: '0'.repeat(64),
    diagnostics: [],
    definition: {
      format: 1,
      id: 'a'.repeat(32),
      name: 'Agents',
      nodes: ['alice', 'bob'].map((id) => ({
        id,
        source: { kind: 'local', manifest: `nodes/${id}/node.json` },
      })),
      edges: [],
    },
    components: { alice: component, bob: component },
  });
}
const from = { node: 'alice', port: 'reply' },
  to = { node: 'bob', port: 'message' };
it('does not replace or duplicate existing routes and rejects missing endpoints', () => {
  const graph = document();
  const next = connectGraph(graph, from, to);
  expect(graph.definition.edges).toEqual([]);
  expect(next.edges).toEqual([{ id: 'connection', from, to }]);
  expect(() => connectGraph({ ...graph, definition: next }, from, to)).toThrow('already exists');
  expect(() => connectGraph(graph, { ...from, port: 'missing' }, to)).toThrow('output no longer');
  expect(() => connectGraph(graph, from, { ...to, node: 'missing' })).toThrow('input no longer');
  expect(() => connectGraph({ ...graph, definition: { ...next, nodes: [] } }, from, to)).toThrow(
    'output no longer',
  );
});
it('rejects incompatible types but retains runtime validation for unknown relationships', () => {
  const graph = document();
  graph.components.bob.inputs.message.schema = { type: 'boolean' };
  expect(connectionProblem(graph, from, to)).toContain('incompatible');
  expect(() => connectGraph(graph, from, to)).toThrow('incompatible');
  graph.components.alice.outputs.reply.schema = {};
  expect(connectionProblem(graph, from, to)).toBeUndefined();
  const next = connectGraph(graph, from, to);
  expect(
    validateHuddleGraph(next, new Map(Object.entries(graph.components))).some(
      (diagnostic) => diagnostic.code === 'runtime_validation',
    ),
  ).toBe(true);
});
it('allows drafting a feedback route while keeping unsafe-cycle validation visible', () => {
  const graph = document();
  const one = connectGraph(graph, from, to);
  const two = connectGraph(
    { ...graph, definition: one },
    { node: 'bob', port: 'reply' },
    { node: 'alice', port: 'message' },
  );
  expect(two.edges.map((edge) => edge.id)).toEqual(['connection', 'connection-2']);
  expect(
    validateHuddleGraph(two, new Map(Object.entries(graph.components))).some(
      (diagnostic) => diagnostic.code === 'unbounded_cycle',
    ),
  ).toBe(true);
});
