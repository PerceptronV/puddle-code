import { huddleComponentSchema, huddleDocumentSchema, type HuddleDocument } from '@puddle/shared';

/** Maximum document node/edge counts, spread beyond a typical pane. No runtime is started. */
export function largeGraph(document: HuddleDocument): HuddleDocument {
  const nodes = Array.from({ length: 256 }, (_, index) => ({
    id: `n${index}`,
    source: { kind: 'local', manifest: 'nodes/fixture/node.json' },
  }));
  const edges = Array.from({ length: 252 }, (_, index) =>
    Array.from({ length: 4 }, (_, port) => ({
      id: `e${index}_${port}`,
      from: { node: `n${index}`, port: `out${port}` },
      to: { node: `n${index + port + 1}`, port: `in${port}` },
    })),
  ).flat();
  for (let index = 0; index < 16; index++)
    edges.push({
      id: `long${index}`,
      from: { node: 'n0', port: 'out4' },
      to: { node: `n${240 + index}`, port: 'in4' },
    });
  const component = huddleComponentSchema.parse({
    format: 1,
    id: 'example.fixture',
    version: 1,
    category: 'script',
    title: 'Fixture',
    entry: 'run.ts',
    inputs: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`in${i}`, { schema: {} }])),
    outputs: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`out${i}`, { schema: {} }])),
  });
  return huddleDocumentSchema.parse({
    ...document,
    definition: { ...document.definition, nodes, edges },
    components: Object.fromEntries(nodes.map((node) => [node.id, component])),
    layout: {
      format: 1,
      nodes: Object.fromEntries(
        nodes.map((node, i) => [node.id, { x: (i % 16) * 420, y: Math.floor(i / 16) * 360 }]),
      ),
    },
  });
}
