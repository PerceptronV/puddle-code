import { expect, it } from 'vitest';
import { z } from 'zod';
import { huddleAuthoringFiles, readHuddleAuthoring } from '../../../src/huddle/authoring/bundle.js';
import { huddleDefinitionSchema } from '../../../src/api/huddle/definitions.js';
import { coreHuddleComponents } from '../../../src/huddle/components/core.js';
import { authoringComponents } from '../../../src/huddle/authoring/templates/components.js';
import { validateHuddleGraph } from '../../../src/huddle/validation/graph.js';

it('lists bounded portable assets and reads only exact names without filesystem interpretation', () => {
  const files = huddleAuthoringFiles();
  const listing = readHuddleAuthoring();
  expect(listing.source).toBe('bundled-client');
  expect(listing.files).toHaveLength(20);
  for (const [path, content] of Object.entries(files)) {
    expect(Buffer.byteLength(content)).toBeLessThan(256 * 1024);
    expect(readHuddleAuthoring(path)).toMatchObject({ path, content });
    expect(content).not.toContain('/Users/');
  }
  for (const path of ['../README.md', '/etc/passwd', 'constructor', '__proto__', './README.md'])
    expect(() => readHuddleAuthoring(path)).toThrow('Unknown authoring asset');
  expect(readHuddleAuthoring()).toEqual(listing);
});

it.each(['manual', 'feed-report'])(
  'ships a valid %s graph with resolved component contracts',
  (name) => {
    const definition = huddleDefinitionSchema.parse(
      JSON.parse(huddleAuthoringFiles()[`examples/${name}.json`]!),
    );
    const components = new Map(
      definition.nodes.map((node) => [
        node.id,
        node.source.kind === 'builtin'
          ? coreHuddleComponents.get(`${node.source.component}@${node.source.version}`)!
          : authoringComponents[node.id as keyof typeof authoringComponents],
      ]),
    );
    expect(validateHuddleGraph(definition, components)).toEqual([]);
  },
);

it('preserves optional source fields and references the bounded value-schema subset', () => {
  const files = huddleAuthoringFiles();
  const graph = JSON.parse(files['schemas/huddle.json']!);
  expect(graph.required).toEqual(['format', 'id', 'name', 'nodes', 'edges']);
  expect(graph.additionalProperties).toBe(false);
  expect(graph.properties.variables.additionalProperties.properties.schema).toEqual({
    $ref: 'value-schema.json',
  });
  const value = JSON.parse(files['schemas/value-schema.json']!);
  const subset = z.fromJSONSchema(value);
  expect(
    subset.safeParse({
      type: 'object',
      properties: { nested: { type: 'array', items: { type: 'string' } } },
    }).success,
  ).toBe(true);
  expect(
    subset.safeParse({ type: 'object', properties: { nested: { unsupportedKeyword: true } } })
      .success,
  ).toBe(false);
  expect(subset.safeParse({ type: 'invented' }).success).toBe(false);
  // Every local reference must resolve in this self-contained schema.
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (key === '$ref') {
        expect(typeof child).toBe('string');
        const path = String(child).split('/').slice(1);
        let target = value;
        for (const part of path) target = target[part.replaceAll('~1', '/').replaceAll('~0', '~')];
        expect(target).toBeDefined();
      } else visit(child);
    }
  };
  visit(value);
});
