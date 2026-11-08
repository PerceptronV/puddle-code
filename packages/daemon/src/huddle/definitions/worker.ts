import { posix } from 'node:path';
import {
  huddleWorkerJobSchema,
  huddleDefinitionSchema,
  canonicalHuddleJson,
  resolveHuddleParameters,
  type HuddleInvocationRecord,
  type HuddleJson,
} from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from './capture.js';
import { huddleRevisionDigest } from './revision.js';

/** Select one component's declared closure from a captured revision, never the current worktree. */
export function prepareHuddleWorkerJob(
  snapshot: HuddleDefinitionSnapshot,
  invocation: HuddleInvocationRecord,
  variables: Record<string, HuddleJson>,
  bindings: Record<string, string>,
) {
  if (
    snapshot.digest !== invocation.revision ||
    huddleRevisionDigest(snapshot.files, snapshot.components) !== snapshot.digest ||
    snapshot.diagnostics.some((item) => item.severity === 'error')
  )
    throw new Error('Invocation needs its exact validated source revision');
  const captured = huddleDefinitionSchema.parse(JSON.parse(snapshot.files['huddle.json']!));
  if (
    canonicalHuddleJson(JSON.parse(JSON.stringify(captured))) !==
    canonicalHuddleJson(JSON.parse(JSON.stringify(snapshot.definition)))
  )
    throw new Error('Graph settings differ from captured source');
  const node = snapshot.definition.nodes.find((node) => node.id === invocation.node);
  const component = snapshot.components[invocation.node];
  if (node?.source.kind !== 'local' || component?.category !== 'script' || !component.entry)
    throw new Error('Invocation has no captured local script');
  const manifest = node.source.manifest.replace(/^\.\//, '');
  const directory = posix.dirname(manifest);
  const paths = [
    manifest,
    ...[component.entry, ...component.dependencies].map((path) => posix.join(directory, path)),
  ];
  return huddleWorkerJobSchema.parse({
    invocationId: invocation.id,
    revision: invocation.revision,
    node: node.id,
    manifest,
    component,
    files: Object.fromEntries(paths.map((path) => [path, snapshot.files[path]])),
    inputs: invocation.inputs,
    parameters: resolveHuddleParameters(snapshot.definition, node, component, variables),
    bindings,
  });
}
