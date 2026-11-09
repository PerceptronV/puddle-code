import { posix } from 'node:path';
import {
  huddleWorkerJobSchema,
  huddleTriggerWorkerJobSchema,
  huddleDefinitionSchema,
  canonicalHuddleJson,
  resolveHuddleParameters,
  type HuddleInvocationRecord,
  type HuddleJson,
  type HuddleWorkerJob,
  type HuddleRevisionActivation,
} from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from './capture.js';
import { huddleRevisionDigest } from './revision.js';

export function prepareHuddleTriggerJob(
  snapshot: HuddleDefinitionSnapshot,
  activation: HuddleRevisionActivation,
  node: string,
  subscriptionId: string,
  cursor: HuddleJson,
) {
  if (snapshot.digest !== activation.revision)
    throw new Error('Subscription needs its exact activation revision');
  const component = snapshot.components[node];
  if (component?.category !== 'trigger') throw new Error('Subscription has no captured trigger');
  return huddleTriggerWorkerJobSchema.parse({
    ...prepareComponentSource(
      snapshot,
      node,
      activation.variables,
      activation.bindings[node] ?? {},
    ),
    subscriptionId,
    cursor,
  });
}

function prepareComponentSource(
  snapshot: HuddleDefinitionSnapshot,
  nodeId: string,
  variables: Record<string, HuddleJson>,
  bindings: Record<string, string>,
) {
  if (
    huddleRevisionDigest(snapshot.files, snapshot.components) !== snapshot.digest ||
    snapshot.diagnostics.some((item) => item.severity === 'error')
  )
    throw new Error('Worker needs its exact validated source revision');
  const captured = huddleDefinitionSchema.parse(JSON.parse(snapshot.files['huddle.json']!));
  if (
    canonicalHuddleJson(JSON.parse(JSON.stringify(captured))) !==
    canonicalHuddleJson(JSON.parse(JSON.stringify(snapshot.definition)))
  )
    throw new Error('Graph settings differ from captured source');
  const node = snapshot.definition.nodes.find((node) => node.id === nodeId);
  const component = snapshot.components[nodeId];
  if (node?.source.kind !== 'local' || !component?.entry)
    throw new Error('Node has no captured executable component');
  const manifest = node.source.manifest.replace(/^\.\//, '');
  const directory = posix.dirname(manifest);
  const paths = [
    manifest,
    ...[component.entry, ...component.dependencies].map((path) => posix.join(directory, path)),
  ];
  return {
    revision: snapshot.digest,
    node: node.id,
    manifest,
    component,
    files: Object.fromEntries(paths.map((path) => [path, snapshot.files[path]])),
    parameters: resolveHuddleParameters(snapshot.definition, node, component, variables),
    bindings,
  };
}

/** Select one component's declared closure from a captured revision, never the current worktree. */
export function prepareHuddleWorkerJob(
  snapshot: HuddleDefinitionSnapshot,
  invocation: HuddleInvocationRecord,
  variables: Record<string, HuddleJson>,
  bindings: Record<string, string>,
  readout?: HuddleWorkerJob['readout'],
) {
  if (snapshot.digest !== invocation.revision)
    throw new Error('Invocation needs its exact validated source revision');
  const node = snapshot.definition.nodes.find((node) => node.id === invocation.node);
  const component = snapshot.components[invocation.node];
  if (
    node?.source.kind !== 'local' ||
    !component?.entry ||
    (!['script', 'readout'].includes(component.category) && !component.hostTrigger)
  )
    throw new Error('Invocation has no captured executable component');
  return huddleWorkerJobSchema.parse({
    ...prepareComponentSource(snapshot, invocation.node, variables, bindings),
    invocationId: invocation.id,
    revision: invocation.revision,
    node: node.id,
    ...(readout ? { readout } : {}),
    inputs: invocation.inputs,
  });
}
