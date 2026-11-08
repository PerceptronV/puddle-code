import {
  canonicalHuddleJson,
  coreHuddleComponents,
  intervalHuddleTrigger,
  HUDDLE_INTERVAL_LIMIT,
  huddleIntervalSettingsSchema,
  resolveHuddleParameters,
  type HuddleRevisionActivation,
  type HuddleRuntimeCapabilities,
} from '@puddle/shared';
import type { HuddleDefinitionSnapshot } from '../../../huddle/definitions/capture.js';

export function intervalDefinitions(
  snapshot: HuddleDefinitionSnapshot,
  activation: HuddleRevisionActivation,
) {
  const nodes = snapshot.definition.nodes.filter(
    (node) => node.source.kind === 'builtin' && node.source.component === intervalHuddleTrigger.id,
  );
  if (nodes.length > HUDDLE_INTERVAL_LIMIT)
    throw new Error(`A huddle supports at most ${HUDDLE_INTERVAL_LIMIT} interval triggers`);
  return nodes.map((node) => ({
    node: node.id,
    ...huddleIntervalSettingsSchema.parse(
      resolveHuddleParameters(
        snapshot.definition,
        node,
        snapshot.components[node.id]!,
        activation.variables,
      ),
    ),
  }));
}

/** Before launch/Apply/arming, including independently received owner requests. */
export function requireHuddleFeatures(
  snapshot: HuddleDefinitionSnapshot,
  capabilities: HuddleRuntimeCapabilities,
) {
  for (const node of snapshot.definition.nodes) {
    const component = snapshot.components[node.id]!;
    if (node.source.kind !== 'builtin') continue;
    const expected = coreHuddleComponents.get(`${node.source.component}@${node.source.version}`);
    if (
      !expected ||
      canonicalHuddleJson(JSON.parse(JSON.stringify(expected))) !==
        canonicalHuddleJson(JSON.parse(JSON.stringify(component)))
    )
      throw new Error('Unsupported captured built-in component');
    if (component.id === intervalHuddleTrigger.id && capabilities.timers !== 1)
      throw new Error('This runtime does not support huddle interval triggers');
  }
}
