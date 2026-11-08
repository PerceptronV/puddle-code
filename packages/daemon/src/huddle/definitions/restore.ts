import { posix } from 'node:path';
import {
  canonicalHuddleJson,
  huddleComponentSchema,
  huddleDefinitionSchema,
  huddleIdSchema,
  huddleLayoutSchema,
  huddleRevisionDocumentSchema,
  validateHuddleGraph,
} from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from './capture.js';
import { huddleRevisionDigest } from './revision.js';

/** Rebuild derived metadata from exact retained bytes, without evaluating project code. */
export function restoreHuddleDefinition(
  input: unknown,
  huddleId: string,
): HuddleDefinitionSnapshot {
  huddleIdSchema.parse(huddleId);
  const document = huddleRevisionDocumentSchema.parse(input);
  if (huddleRevisionDigest(document.files, document.components) !== document.digest)
    throw new Error('Huddle revision digest does not match its retained source');
  const definition = huddleDefinitionSchema.parse(JSON.parse(document.files['huddle.json']!));
  if (definition.id !== huddleId) throw new Error('Revision belongs to another huddle');
  const layout =
    document.files['layout.json'] === undefined
      ? undefined
      : huddleLayoutSchema.parse(JSON.parse(document.files['layout.json']));
  const paths = new Set(['huddle.json', ...(layout ? ['layout.json'] : [])]);
  const nodeIds = new Set(definition.nodes.map((node) => node.id));
  if (Object.keys(document.components).some((node) => !nodeIds.has(node)))
    throw new Error('Revision contains an unrelated component');
  for (const node of definition.nodes) {
    const component = document.components[node.id];
    if (!component) throw new Error('Revision component is missing');
    if (node.source.kind !== 'local') continue;
    const manifest = node.source.manifest.replace(/^\.\//, '');
    paths.add(manifest);
    const captured = huddleComponentSchema.parse(JSON.parse(document.files[manifest]!));
    if (
      canonicalHuddleJson(JSON.parse(JSON.stringify(component))) !==
      canonicalHuddleJson(JSON.parse(JSON.stringify(captured)))
    )
      throw new Error('Retained component differs from its manifest');
    if (!component.entry) throw new Error('Retained local component has no entry point');
    const dependencies = [component.entry, ...component.dependencies].map((path) =>
      posix.join(posix.dirname(manifest), path),
    );
    if (new Set(dependencies).size !== dependencies.length)
      throw new Error('Duplicate retained dependency');
    for (const path of dependencies) {
      if (!Object.hasOwn(document.files, path))
        throw new Error('Retained component dependency is missing');
      paths.add(path);
    }
  }
  if (
    Object.keys(document.files).length !== paths.size ||
    Object.keys(document.files).some((path) => !paths.has(path))
  )
    throw new Error('Revision source does not match its declared graph closure');
  const diagnostics = validateHuddleGraph(definition, new Map(Object.entries(document.components)));
  const invalid = diagnostics.find((item) => item.severity === 'error');
  if (invalid) throw new Error(`Invalid retained graph: ${invalid.message}`);
  return { ...document, definition, ...(layout ? { layout } : {}), diagnostics };
}
