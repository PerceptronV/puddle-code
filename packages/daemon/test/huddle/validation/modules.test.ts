import { expect, it } from 'vitest';
import {
  huddleAuthoringFiles,
  huddleComponentSchema,
  huddleDefinitionSchema,
} from '@puddle/shared';
import { validateHuddleModules } from '../../../src/huddle/validation/modules.js';
import { validateHuddleFixture } from '../../../src/huddle/validation/fixtures.js';
import type { HuddleDefinitionSnapshot } from '../../../src/huddle/definitions/capture.js';

function snapshot(source: string): HuddleDefinitionSnapshot {
  const component = huddleComponentSchema.parse({
    format: 1,
    id: 'example.node',
    version: 1,
    title: 'Example',
    category: 'script',
    entry: './run.ts',
    inputs: { value: { schema: { type: 'string' } } },
    outputs: {
      completed: { schema: { type: 'string' } },
      progress: { schema: { type: 'number' }, emission: 'event' },
    },
  });
  return {
    format: 1,
    digest: 'a'.repeat(64),
    diagnostics: [],
    definition: huddleDefinitionSchema.parse({
      format: 1,
      id: 'a'.repeat(32),
      name: 'Fixture',
      nodes: [{ id: 'script', source: { kind: 'local', manifest: 'nodes/script/node.json' } }],
      edges: [],
    }),
    components: { script: component },
    files: { 'nodes/script/node.json': JSON.stringify(component), 'nodes/script/run.ts': source },
  };
}
const valid = `import { HuddleNode as Node } from 'puddlang/huddle';
const settings = { contract:'./node.json', run({inputs}: {inputs: Record<string,string>}) { return {completed:inputs.value}; } };
export default Node(settings);`;

it('checks every shipped adapter declaration and captured dependency without evaluating modules', () => {
  const files = huddleAuthoringFiles();
  const graph = snapshot(valid);
  graph.definition.nodes = [];
  graph.components = {};
  graph.files = files;
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith('/node.json')) continue;
    const id = `n${graph.definition.nodes.length}`;
    graph.definition.nodes.push({
      id,
      source: { kind: 'local', manifest: path },
      parameters: {},
      concurrency: 1,
    });
    graph.components[id] = huddleComponentSchema.parse(JSON.parse(text));
  }
  expect(graph.definition.nodes.length).toBeGreaterThan(15);
  expect(validateHuddleModules(graph)).toEqual([]);
});

it('reports syntax, undeclared dependencies, wrong wrappers and ambiguous contract declarations', () => {
  expect(validateHuddleModules(snapshot(valid))).toEqual([]);
  for (const [source, code] of [
    [valid.replace('./node.json', './other.json'), 'module_contract'],
    [valid.replace('HuddleNode as', 'HuddleTrigger as'), 'module_contract'],
    [valid.replace("contract:'./node.json'", 'contract:process.env.CONTRACT'), 'module_contract'],
    [
      valid.replace(
        'run({inputs}: {inputs: Record<string,string>})',
        'noRun({inputs}: {inputs: Record<string,string>})',
      ),
      'module_contract',
    ],
    [`import './missing.ts';\n${valid}`, 'module_import'],
    [`await import(process.env.MODULE);\n${valid}`, 'module_import'],
    [valid + '\nconst broken = ;', 'module_syntax'],
  ])
    expect(validateHuddleModules(snapshot(source!))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'error', node: 'script', code }),
      ]),
    );
});

it('checks fixture input, completion and event values using the runtime contracts', () => {
  const graph = snapshot(valid);
  const fixture = (sample: object) =>
    JSON.stringify({ format: 1, cases: [{ name: 'Sample', node: 'script', ...sample }] });
  expect(
    validateHuddleFixture(
      graph,
      fixture({
        inputs: { value: 'hello' },
        outputs: { completed: 'world' },
        emissions: [{ port: 'progress', value: 1 }],
      }),
      'samples.json',
    ).diagnostics,
  ).toEqual([]);
  const result = validateHuddleFixture(
    graph,
    fixture({
      inputs: { value: 42 },
      outputs: { wrong: 'world' },
      emissions: [{ port: 'completed', value: 'bad' }],
    }),
    'samples.json',
  );
  expect(result.diagnostics).toHaveLength(3);
  expect(
    result.diagnostics.every(
      (item) => item.node === 'script' && item.path.startsWith('/fixtures/samples.json/cases/0/'),
    ),
  ).toBe(true);
});
